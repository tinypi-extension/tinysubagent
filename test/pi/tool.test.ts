/**
 * Routing wiring through the registered tool.
 *
 * The `route` dependency is the seam: every test here injects a fake (or a
 * never-resolving real one), so no test ever touches the network. What is
 * pinned is the contract S5/S6 promised: a routed batch launches each child on
 * its own profile, every routing failure lands on `current`, an unknown agent
 * sends no brief anywhere, routing off costs zero route calls, a hung route
 * cannot hold the spawn past the client's own budget, and neither the key nor
 * the endpoint ever reaches the model.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type TinysubagentConfig } from "../../src/config/config.ts";
import { LiveSubPanes } from "../../src/herdr/layout.ts";
import { buildParameters } from "../../src/present/describe.ts";
import { createTool } from "../../src/pi/tool.ts";
import { createRouteFn, type RouteFn, type RouteInput } from "../../src/systemone/route.ts";
import type { AgentDef } from "../../src/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const KEY = "sk-test-DEADBEEF";
const BASE_URL = "https://api.typesafe.ai";

function routingConfig(systemOne: TinysubagentConfig["systemOne"]): TinysubagentConfig {
	return {
		enableProfiles: true,
		profiles: {
			light: { model: "m-light", thinking: "low" },
			pro: { model: "m-pro", thinking: "high" },
		},
		env: {},
		systemOne,
		sources: [],
	};
}

const systemOneOn = { apiKey: KEY, baseUrl: BASE_URL, file: "test" };

/** The smallest `ExtensionAPI` the tool body touches. */
function stubPi(): import("@earendil-works/pi-coding-agent").ExtensionAPI {
	return {
		on() {},
		registerTool() {},
		sendMessage() {},
		getAllTools() {
			return [];
		},
	} as never;
}

const workerAgent: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	source: "user",
	path: "/tmp/worker.md",
};

/**
 * A built tool plus the scratch project, herdr environment, and fake session
 * context `execute` needs. `stop()` ends the completion watcher; `cleanup()`
 * restores everything else.
 */
function harness(config: TinysubagentConfig, route: RouteFn) {
	let shuttingDown = false;
	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config),
		advertisedAgents: [workerAgent],
		capability: { ensureReady: async () => null },
		columns: new LiveSubPanes(),
		watchers: new Set(),
		isShuttingDown: () => shuttingDown,
		route,
	});

	const cwd = mkdtempSync(join(tmpdir(), "tinysubagent-tool-route-"));
	// `.pi/agents` gives execute a `worker` role; `.pi/agent` makes
	// `resolveProjectAgentDir` return the scratch dir, so no child session
	// directory is created under the real agent dir.
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: does work\n---\nYou work.\n");

	const ctx = {
		cwd,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionFile: () => join(cwd, "sessions", "sid.jsonl"),
			getSessionId: () => "sid",
		},
	};

	const saved = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"].map(
		(key) => [key, process.env[key]] as const,
	);
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";

	return {
		tool,
		cwd,
		ctx,
		stop: () => {
			shuttingDown = true;
		},
		cleanup: () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

const STATUS_OK = JSON.stringify({ id: "cli:status", result: { running: true, version: "0.8.2" } });
const STUB_LAYOUT = JSON.stringify({
	id: "cli:pane",
	result: {
		layout: {
			tab_id: "tab-1",
			panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 211, height: 58 } }],
		},
	},
});
const STUB_OPENED = JSON.stringify({
	id: "cli:plugin",
	result: { plugin_pane: { pane: { pane_id: "w1:p1Z" } } },
});
const STUB_OK = '{"id":"cli:pane","result":{"ok":true}}';

/** A herdr binary that answers the whole spawn path, so no pane is really opened. */
async function withSpawnHerdrStub<T>(fn: () => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-tool-herdr-"));
	const stub = join(dir, "herdr");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			'case "$1 $2" in',
			`  "status server") printf '%s' ${JSON.stringify(STATUS_OK).replaceAll("'", `'\\''`)} ;;`,
			`  "plugin pane") printf '%s' ${JSON.stringify(STUB_OPENED).replaceAll("'", `'\\''`)} ;;`,
			`  "pane layout") printf '%s' ${JSON.stringify(STUB_LAYOUT).replaceAll("'", `'\\''`)} ;;`,
			'  "pane resize"|"pane rename"|"pane close") printf \'%s\' \'{"id":"cli:pane","result":{"ok":true}}\' ;;',
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

function executeTool(tool: { execute: unknown }, ctx: unknown, params: unknown): Promise<unknown> {
	const execute = tool.execute as (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	return execute("call-1", params, undefined, () => {}, ctx);
}

function contentText(result: unknown): string {
	const first = (result as { content?: { type: string; text?: string }[] }).content?.[0];
	assert.equal(first?.type, "text", "the tool returned no text content");
	return first?.text ?? "";
}

/** The launch scripts the spawn wrote, read back off disk. */
function writtenScripts(cwd: string): string[] {
	const dir = join(cwd, "sessions", "artifacts", "sid", "subagent-scripts");
	return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
}

// ────────────────────────────────────────────────────────────────────────────
// The routed batch
// ────────────────────────────────────────────────────────────────────────────

test("a batch's two requests are routed independently and each child launches on its own profile", async () => {
	const calls: RouteInput[] = [];
	const route: RouteFn = async (input) => {
		calls.push(input);
		return { choice: input.task.includes("heavy") ? "pro" : "light" };
	};
	const h = harness(routingConfig(systemOneOn), route);
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "light work", name: "one" },
					{ agent: "worker", task: "heavy work", name: "two" },
				],
			}),
		);

		assert.equal(calls.length, 2, `route called ${calls.length} times for a two-task batch`);
		for (const call of calls) {
			assert.equal(call.agent.name, "worker");
			assert.equal(call.agent.description, "does work");
			// One criterion per candidate, describing what the profile launches with.
			assert.deepEqual(call.criteria, {
				light: "model m-light, thinking low",
				pro: "model m-pro, thinking high",
			});
		}

		const scripts = writtenScripts(h.cwd);
		assert.equal(scripts.length, 2);
		const light = scripts.find((script) => script.includes("'m-light'"));
		const pro = scripts.find((script) => script.includes("'m-pro'"));
		assert.ok(light, "no child launched on the light profile");
		assert.ok(pro, "no child launched on the pro profile");
		assert.ok(light.includes("'--model' 'm-light'") && light.includes("'--thinking' 'low'"));
		assert.ok(!light.includes("'m-pro'") && !light.includes("'high'"));
		assert.ok(pro.includes("'--model' 'm-pro'") && pro.includes("'--thinking' 'high'"));
		assert.ok(!pro.includes("'m-light'") && !pro.includes("'low'"));

		const text = contentText(result);
		assert.match(text, /\[light\]/, `the ack never named the routed profile: ${text}`);
		assert.match(text, /\[pro\]/, `the ack never named the routed profile: ${text}`);
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Every routing failure lands on current
// ────────────────────────────────────────────────────────────────────────────

test("a routing failure still spawns, on the current profile, in both failure shapes", async () => {
	const cases: [string, RouteFn][] = [
		[
			"a route that throws",
			async () => {
				throw new Error("routing is down");
			},
		],
		["a route with no choice", async () => ({ choice: null })],
	];
	for (const [label, route] of cases) {
		const h = harness(routingConfig(systemOneOn), route);
		try {
			const result = await withSpawnHerdrStub(() =>
				executeTool(h.tool, h.ctx, { agent: "worker", task: "one job" }),
			);
			const text = contentText(result);
			assert.match(text, /\[current\]/, `${label}: the ack never named the current profile: ${text}`);
			const scripts = writtenScripts(h.cwd);
			assert.equal(scripts.length, 1, `${label}: the child did not spawn`);
			assert.ok(scripts[0] && !scripts[0].includes("'--model'"), `${label}: the child carried a --model flag`);
			assert.ok(scripts[0] && !scripts[0].includes("'--thinking'"), `${label}: the child carried a --thinking flag`);
		} finally {
			h.stop();
			h.cleanup();
		}
	}
});

// ────────────────────────────────────────────────────────────────────────────
// No brief leaves the process for a spawn that will be refused
// ────────────────────────────────────────────────────────────────────────────

test("an unknown agent triggers no route call and still fails with the usual error", async () => {
	let calls = 0;
	const route: RouteFn = async () => {
		calls++;
		return { choice: "light" };
	};
	const h = harness(routingConfig(systemOneOn), route);
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { agent: "nope", task: "a brief that must not travel" }),
		);
		assert.equal(calls, 0, "routing saw the brief of an unknown agent");
		const text = contentText(result);
		assert.match(text, /unknown agent "nope"/);
		assert.equal((result as { isError?: boolean }).isError, true);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("with routing off the route function is never called", async () => {
	let calls = 0;
	const route: RouteFn = async () => {
		calls++;
		return { choice: "light" };
	};
	const h = harness(routingConfig(null), route);
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { agent: "worker", task: "one job" }),
		);
		assert.equal(calls, 0, "routing ran without a configured key");
		assert.match(contentText(result), /\[current\]/);
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// The spawn path is bounded by the routing client's own abort
// ────────────────────────────────────────────────────────────────────────────

test("a never-resolving route does not block the spawn beyond the routing budget", async () => {
	// A fetch that never fulfills on its own — only the client's own abort ends
	// it, exactly as a real network read would be ended by `AbortController`.
	const hangingFetch = ((_url: unknown, init?: RequestInit) => {
		const signal = (init as RequestInit & { signal: AbortSignal }).signal;
		assert.ok(signal, "the controller signal must reach the fetch call");
		return new Promise<never>((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => reject(new DOMException("aborted", "AbortError")),
				{ once: true },
			);
		});
	}) as unknown as typeof fetch;
	const route = createRouteFn(routingConfig(systemOneOn), { fetch: hangingFetch, timeoutMs: 20 });
	const h = harness(routingConfig(systemOneOn), route);
	try {
		const started = Date.now();
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { agent: "worker", task: "one job" }),
		);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 1000, `execute took ${elapsed}ms — the routing budget did not bound the spawn`);
		const text = contentText(result);
		assert.match(text, /\[current\]/, `the child did not spawn on current: ${text}`);
		assert.equal(writtenScripts(h.cwd).length, 1, "the child did not spawn");
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Neither the key nor the endpoint reaches the model
// ────────────────────────────────────────────────────────────────────────────

test("the key and the endpoint appear in no description, schema, or result text", async () => {
	const config = routingConfig(systemOneOn);
	const route: RouteFn = async () => ({ choice: "light" });
	const h = harness(config, route);
	try {
		const description = h.tool.description;
		const schema = JSON.stringify(h.tool.parameters);
		assert.ok(!description.includes(KEY), "the description leaks the key");
		assert.ok(!description.includes(BASE_URL), "the description leaks the endpoint");
		assert.ok(!schema.includes(KEY), "the parameter schema leaks the key");
		assert.ok(!schema.includes(BASE_URL), "the parameter schema leaks the endpoint");

		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { agent: "worker", task: "one job" }),
		);
		const text = contentText(result);
		assert.ok(!text.includes(KEY), "the result text leaks the key");
		assert.ok(!text.includes(BASE_URL), "the result text leaks the endpoint");
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// A stale profile in the request never survives routing
// ────────────────────────────────────────────────────────────────────────────

test("a stale profile in the request is routed anyway, and routing's word is final", async () => {
	// Single mode here; a stale `profile` on a `tasks[]` item flows through the same
	// routeProfiles rewrite, so this pins the invariant once.
	const cases: { name: string; route: RouteFn; ack: RegExp; model: string | null }[] = [
		{
			name: "a routed choice overwrites the stale value",
			route: async () => ({ choice: "pro" }),
			ack: /\[pro\]/,
			model: "m-pro",
		},
		{
			name: "no decision clears the stale value onto current",
			route: async () => ({ choice: null }),
			ack: /\[current\]/,
			model: null,
		},
	];

	for (const c of cases) {
		const h = harness(routingConfig(systemOneOn), c.route);
		try {
			const result = await withSpawnHerdrStub(() =>
				executeTool(h.tool, h.ctx, { agent: "worker", task: "one job", profile: "light" }),
			);
			const text = contentText(result);
			assert.match(text, c.ack, `${c.name}: ${text}`);
			assert.doesNotMatch(text, /\[light\]/, `${c.name}: the stale profile survived: ${text}`);

			const script = writtenScripts(h.cwd)[0];
			assert.ok(script, `${c.name}: the child did not spawn`);
			if (c.model === null) {
				assert.ok(
					!script.includes("'--model'") && !script.includes("'--thinking'"),
					`${c.name}: the child carried model/thinking flags onto current: ${script}`,
				);
			} else {
				assert.ok(script.includes(`'--model' '${c.model}'`), `${c.name}: ${script}`);
				assert.ok(script.includes("'--thinking' 'high'"), `${c.name}: ${script}`);
				assert.ok(
					!script.includes("'m-light'") && !script.includes("'low'"),
					`${c.name}: the stale profile reached the child: ${script}`,
				);
			}
		} finally {
			h.stop();
			h.cleanup();
		}
	}
});
