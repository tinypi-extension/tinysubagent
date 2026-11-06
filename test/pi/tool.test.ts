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

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TinysubagentConfig } from "../../src/config/config.ts";
import { LiveSubPanes } from "../../src/herdr/layout.ts";
import { RunningLabels } from "../../src/children/running-labels.ts";
import { buildParameters, buildToolDescription } from "../../src/present/describe.ts";
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
		classifier: null,
		sources: [],
	};
}

const systemOneOn = { apiKey: KEY, baseUrl: BASE_URL, model: "jev-latest", file: "test" };

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
function harness(config: TinysubagentConfig, route: (ctx: ExtensionContext) => RouteFn) {
	let shuttingDown = false;
	const watchers = new Set<AbortController>();
	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config),
		advertisedAgents: [workerAgent],
		capability: { ensureReady: async () => null },
		columns: new LiveSubPanes(),
		runningLabels: new RunningLabels(),
		watchers,
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

	const notices: { message: string; level: string }[] = [];
	const ctx = {
		cwd,
		ui: {
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
		},
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
		notices,
		stop: () => {
			shuttingDown = true;
		},
		/** End every running child's wait, as a shutdown or a vanished pane would. */
		settleAll: () => {
			for (const controller of watchers) controller.abort();
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
	const h = harness(routingConfig(systemOneOn), () => route);
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
		const h = harness(routingConfig(systemOneOn), () => route);
		try {
			const result = await withSpawnHerdrStub(() =>
				executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }),
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
	const h = harness(routingConfig(systemOneOn), () => route);
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "nope", task: "a brief that must not travel" }] }),
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
	const h = harness(routingConfig(null), () => route);
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }),
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
	const h = harness(routingConfig(systemOneOn), () => route);
	try {
		const started = Date.now();
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }),
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
	const h = harness(config, () => route);
	try {
		const description = h.tool.description;
		const schema = JSON.stringify(h.tool.parameters);
		assert.ok(!description.includes(KEY), "the description leaks the key");
		assert.ok(!description.includes(BASE_URL), "the description leaks the endpoint");
		assert.ok(!schema.includes(KEY), "the parameter schema leaks the key");
		assert.ok(!schema.includes(BASE_URL), "the parameter schema leaks the endpoint");

		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }),
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
// Explicit profiles bypass routing
// ────────────────────────────────────────────────────────────────────────────

test("an explicit profile overrides automatic routing", async () => {
	let routeCalls = 0;
	const h = harness(routingConfig(systemOneOn), () => async () => {
		routeCalls++;
		return { choice: "pro" };
	});
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job", profile: "light" }] }),
		);
		assert.match(contentText(result), /\[light\]/);
		assert.equal(routeCalls, 0, "the router should not be called for an explicit profile");

		const script = writtenScripts(h.cwd)[0];
		assert.ok(script?.includes("'--model' 'm-light'"), `explicit profile did not reach child: ${script}`);
		assert.ok(script?.includes("'--thinking' 'low'"), `explicit profile did not reach child: ${script}`);
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// The route factory is built lazily, only when routing is active
// ────────────────────────────────────────────────────────────────────────────

test("the route factory is never invoked when profiles are off", async () => {
	let factoryCalls = 0;
	let routeCalls = 0;
	const config: TinysubagentConfig = { ...routingConfig(null), enableProfiles: false };
	const h = harness(config, () => {
		factoryCalls++;
		return async () => {
			routeCalls++;
			return { choice: "light" };
		};
	});
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }),
		);
		assert.equal(factoryCalls, 0, "the route factory ran with routing off");
		assert.equal(routeCalls, 0, "the route ran with routing off");
		assert.match(contentText(result), /\[current\]/);
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// `classifierModel` alone keeps profile as an optional override
// ────────────────────────────────────────────────────────────────────────────

test("classifier routing shows an info notice when a profile is chosen automatically", async () => {
	const config: TinysubagentConfig = {
		...routingConfig(null),
		classifier: {
			provider: "openrouter",
			model: "typesafe/jev-latest",
			raw: "openrouter/typesafe/jev-latest",
		},
	};
	const h = harness(config, () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(() => executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] }));
		assert.deepEqual(h.notices, [{
			message: "tinysubagent: routing profile with classifier model openrouter/typesafe/jev-latest.",
			level: "info",
		}]);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("tool description says subagents start immediately, not queued", () => {
	const config = routingConfig(null);
	const description = buildToolDescription([workerAgent], config);
	assert.match(description, /starts the requested subagent\(s\) immediately/);
	assert.match(description, /does not queue or defer them for later/);
	assert.match(description, /tasks` array with one or more subagents/);
	assert.doesNotMatch(description, /Modes: single/);
	assert.match(description, /All requested subagents run concurrently/);
	assert.match(description, /Subagents run concurrently and report back together/);
});

test("only classifierModel set keeps the profile list and parameter", () => {
	const routed: TinysubagentConfig = {
		...routingConfig(null),
		classifier: {
			provider: "openrouter",
			model: "typesafe/jev-latest",
			raw: "openrouter/typesafe/jev-latest",
		},
	};
	// Positive control: with no transport, routing is off and the knob survives.
	const unrouted: TinysubagentConfig = { ...routed, classifier: null };
	assert.match(buildToolDescription([workerAgent], unrouted), /Profiles:/);
	assert.ok(JSON.stringify(buildParameters(unrouted)).includes('"profile"'));

	assert.match(buildToolDescription([workerAgent], routed), /Profiles:/);
	assert.match(buildToolDescription([workerAgent], routed), /choose automatically/);
	assert.ok(JSON.stringify(buildParameters(routed)).includes('"profile"'));
});

// ────────────────────────────────────────────────────────────────────────────
// A Label that is already running is never spawned twice
// ────────────────────────────────────────────────────────────────────────────

/** The child's report sidecar, read back off the generated launch script. */
function reportFileFrom(script: string): string {
	const match = script.match(/export PI_TINYSUBAGENT_REPORT='((?:[^']|'\\'')*)'/);
	assert.ok(match, `no report path in the launch script:\n${script}`);
	return (match[1] ?? "").replaceAll("'\\''", "'");
}

function isErrorFlag(result: unknown): boolean | undefined {
	return (result as { isError?: boolean }).isError;
}

test("a later call reusing a running label is skipped and launches nothing", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			assert.match(contentText(first), /\(alpha\)/, "the first spawn never started");
			assert.equal(writtenScripts(h.cwd).length, 1, "the first spawn wrote no launch script");

			const second = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job", name: "alpha" }],
			});
			const text = contentText(second);
			assert.match(text, /alpha/, `the skip notice never named the running label: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 1, "the duplicate request launched a second child");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a mixed batch skips only the duplicate and starts the rest", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			assert.equal(writtenScripts(h.cwd).length, 1, "the first spawn wrote no launch script");

			const result = await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "a duplicate job", name: "alpha" },
					{ agent: "worker", task: "a fresh job", name: "beta" },
				],
			});
			const text = contentText(result);
			assert.match(text, /skipped alpha/, `the skip notice never named the running label: ${text}`);
			assert.match(text, /\(beta\)/, `the fresh request never started: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "the batch launched the wrong number of children");
			assert.notEqual(isErrorFlag(result), true, "a partly skipped batch was reported as an error");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a call whose every label is already running is informational, not a tool error", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the first job", name: "alpha" },
					{ agent: "worker", task: "the second job", name: "beta" },
				],
			});
			assert.equal(writtenScripts(h.cwd).length, 2, "the first batch wrote the wrong number of scripts");

			const result = await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "a duplicate job", name: "alpha" },
					{ agent: "worker", task: "another duplicate job", name: "beta" },
				],
			});
			const text = contentText(result);
			assert.match(text, /skipped alpha/, `the notice never named the first running label: ${text}`);
			assert.match(text, /skipped beta/, `the notice never named the second running label: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "an all-skipped call launched a child");
			assert.notEqual(isErrorFlag(result), true, "an all-skipped call was reported as a tool error");
			const details = (result as { details?: { status?: string } }).details;
			assert.notEqual(details?.status, "error", "an all-skipped call carried the error status");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

/** The Briefs written to disk, read back off the artifact directory. */
function writtenBriefs(cwd: string): string[] {
	const dir = join(cwd, "sessions", "artifacts", "sid", "context");
	return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
}

test("a skipped request is never routed and never gets a Brief", async () => {
	const routed: string[] = [];
	const route: RouteFn = async (input) => {
		routed.push(input.task);
		return { choice: "light" };
	};
	const h = harness(routingConfig(systemOneOn), () => route);
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			routed.length = 0;

			await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "a duplicate brief", name: "alpha" },
					{ agent: "worker", task: "a fresh brief", name: "beta" },
				],
			});

			assert.deepEqual(routed, ["a fresh brief"], "the skipped request was routed");
			const briefs = writtenBriefs(h.cwd);
			assert.equal(briefs.length, 2, "the skipped request wrote a Brief");
			assert.ok(!briefs.some((brief) => brief.includes("a duplicate brief")), "the skipped brief reached disk");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

/** Poll a check that only becomes true once a child's wait has settled. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(what);
}

/** Whether one more `alpha` spawn gets through; a skipped call writes nothing. */
async function spawnsAlphaAgain(h: ReturnType<typeof harness>): Promise<boolean> {
	const before = writtenScripts(h.cwd).length;
	await executeTool(h.tool, h.ctx, {
		tasks: [{ agent: "worker", task: "work after the label was released", name: "alpha" }],
	});
	return writtenScripts(h.cwd).length > before;
}

test("a label is free again once its subagent's wait ends", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			const blocked = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job", name: "alpha" }],
			});
			assert.match(contentText(blocked), /skipped alpha/, "the label was not held while the child ran");

			h.settleAll();
			await until(() => spawnsAlphaAgain(h), "the label was still held after its subagent stopped");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a label is free again after its subagent reports", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			const script = writtenScripts(h.cwd)[0] ?? assert.fail("no launch script was written");
			writeFileSync(reportFileFrom(script), JSON.stringify({ type: "done", result: "the first job is done" }));

			await until(() => spawnsAlphaAgain(h), "the label was still held after its subagent reported");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a refused spawn gives its label back at once", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const refused = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "nope", task: "a role that does not exist", name: "alpha" }],
			});
			assert.equal(isErrorFlag(refused), true, "an unknown agent was not reported as a failure");

			const retried = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the real job", name: "alpha" }],
			});
			const text = contentText(retried);
			assert.match(text, /\(alpha\)/, `the refused spawn kept its label: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 1, "the retry launched the wrong number of children");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("labels match exactly and case-sensitively", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const both = await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the upper job", name: "Alpha" },
					{ agent: "worker", task: "the lower job", name: "alpha" },
				],
			});
			const text = contentText(both);
			assert.doesNotMatch(text, /skipped/, `two distinct labels were treated as one: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "a batch with two distinct labels did not start both children");

			const exact = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the duplicate job", name: "alpha" }],
			});
			assert.match(contentText(exact), /skipped alpha/, "an exact reuse of a running label was not skipped");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an omitted label is checked by the role-derived default", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job" }],
			});
			assert.match(contentText(first), /\(worker\)/, "the default label was not the role name");

			const second = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job" }],
			});
			assert.match(
				contentText(second),
				/skipped worker/,
				"a default-labelled spawn was not checked against the running label",
			);
			assert.equal(writtenScripts(h.cwd).length, 1, "the default-labelled duplicate was launched");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("suffixing inside a batch still works around a running label", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});

			const result = await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "a duplicate job", name: "alpha" },
					{ agent: "worker", task: "a suffixed job", name: "alpha" },
				],
			});
			const text = contentText(result);
			assert.match(text, /skipped alpha/, `the first request was not skipped: ${text}`);
			assert.match(text, /\(alpha-2\)/, `the suffixed request never started: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "the batch launched the wrong number of children");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});
