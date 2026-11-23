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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { type TinysubagentConfig } from "../../src/config/config.ts";
import { LiveSubPanes } from "../../src/herdr/layout.ts";
import { buildParameters, buildPromptGuidelines, buildToolDescription } from "../../src/present/describe.ts";
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
function harness(
	config: TinysubagentConfig,
	route: (ctx: ExtensionContext) => RouteFn,
	options: { columns?: LiveSubPanes; branch?: SessionEntry[]; sessionFile?: string | null } = {},
) {
	const watchers = new Set<AbortController>();
	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config),
		advertisedAgents: [workerAgent],
		capability: { ensureReady: async () => null },
		columns: options.columns ?? new LiveSubPanes(),
		watchers,
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
			// `null` is `--no-session`: this orchestrator has no file to fork.
			getSessionFile: () =>
				options.sessionFile === undefined ? join(cwd, "sessions", "sid.jsonl") : options.sessionFile,
			getSessionId: () => "sid",
			buildContextEntries: () => options.branch ?? [],
			getHeader: () => ({ type: "session", id: "sid", timestamp: "2026-11-23T06:00:00.000Z", cwd, version: 3 }),
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
			// A shutdown ends the blocking waits and leaves the panes open, exactly as
			// `session_shutdown` does, reason included.
			for (const controller of watchers) controller.abort("shutdown");
		},
		/** End every running child's wait, as a shutdown or a vanished pane would. */
		settleAll: () => {
			for (const controller of watchers) controller.abort("shutdown");
		},
		/** How many waits are registered, so a test can settle once they exist. */
		watching: () => watchers.size,
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
const STUB_OK = '{"id":"cli:pane","result":{"ok":true}}';

interface HerdrStubOptions {
	/** Pane ids whose `pane send-keys` fails, the way a pane that is already gone does. */
	readonly failSendKeys?: readonly string[];
	/**
	 * Hold `plugin pane open` until this path exists. That is the deterministic
	 * gate for catching an abort while a spawn is genuinely in flight: no sleep
	 * decides the ordering, the test does.
	 */
	readonly holdPaneOpenUntil?: string;
}

/**
 * A herdr binary that answers the whole spawn path, so no pane is really opened.
 *
 * It is stateful on purpose: every `plugin pane open` hands out the next pane id
 * (`w1:p1Z`, `w1:p2Z`, …) and `pane layout` reports the orchestrator plus every
 * pane opened so far. A stateless stub that re-reports one id would let
 * `applySpawnResizes` prune the tracker empty after every spawn, so a fan-out
 * test would prove nothing.
 *
 * Every invocation is appended to a log beside the stub, so a test can assert on
 * what the tool asked herdr to do — and on what it did not: a cancelled child's
 * pane must stay open.
 */
async function withSpawnHerdrStub<T>(
	fn: (calls: () => string[]) => Promise<T>,
	options: HerdrStubOptions = {},
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-tool-herdr-"));
	const stub = join(dir, "herdr");
	const log = `${stub}.log`;
	const state = `${stub}.state`;
	const failSendKeys = ["", ...(options.failSendKeys ?? []), ""].join(" ");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${shellQuote(log)}`,
			'case "$1 $2" in',
			`  "status server") printf '%s' ${shellQuote(STATUS_OK)} ;;`,
			`  "plugin pane")`,
			`    gate=${shellQuote(options.holdPaneOpenUntil ?? "")}`,
			'    if [ -n "$gate" ] && [ ! -f "$gate" ]; then while [ ! -f "$gate" ]; do sleep 0.01; done; fi',
			// `mkdir` is the atomic part: two concurrent calls each get their own id,
			// so a fan-out test cannot accidentally have both land on one pane.
			"    n=1",
			`    while ! mkdir ${shellQuote(state)}.$n 2>/dev/null; do n=$((n + 1)); done`,
			'    printf \'{"id":"cli:plugin","result":{"plugin_pane":{"pane":{"pane_id":"w1:p%sZ"}}}}\' "$n" ;;',
			'  "pane layout")',
			`    n=$(ls -d ${shellQuote(state)}.* 2>/dev/null | wc -l | tr -d ' ')`,
			'    panes=\'{"pane_id":"w1:p1","rect":{"x":0,"y":0,"width":211,"height":58}}\'',
			'    i=1',
			'    while [ "$i" -le "$n" ]; do',
			'      panes="$panes,{\\"pane_id\\":\\"w1:p${i}Z\\",\\"rect\\":{\\"x\\":211,\\"y\\":$(((i - 1) * 29)),\\"width\\":100,\\"height\\":29}}"',
			'      i=$((i + 1))',
			'    done',
			'    printf \'{"id":"cli:pane","result":{"layout":{"tab_id":"tab-1","panes":[%s]}}}\' "$panes" ;;',
			'  "pane send-keys")',
			`    case ${shellQuote(failSendKeys)} in`, // ` esc ` — the pane id is $3
			'      *" $3 "*) printf \'{"error":{"code":"pane_not_found"}}\' >&2; exit 1 ;;',
			'    esac',
			`    printf '%s' ${shellQuote(STUB_OK)} ;;`,
			`  "pane resize"|"pane rename"|"pane close") printf '%s' ${shellQuote(STUB_OK)} ;;`,
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);

	/** Every herdr command run so far, in order. */
	const calls = (): string[] => {
		try {
			return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
		} catch {
			return [];
		}
	};

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		return await fn(calls);
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Quote a value so the generated bash stub reads it back literally. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executeTool(
	tool: { execute: unknown },
	ctx: unknown,
	params: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const execute = tool.execute as (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	return execute("call-1", params, signal, () => {}, ctx);
}

function contentText(result: unknown): string {
	const first = (result as { content?: { type: string; text?: string }[] }).content?.[0];
	assert.equal(first?.type, "text", "the tool returned no text content");
	return first?.text ?? "";
}

/** The launch scripts the spawn wrote, read back off disk. */
function writtenScripts(cwd: string): string[] {
	const dir = join(cwd, "sessions", "artifacts", "sid", "subagent-scripts");
	try {
		return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
	} catch {
		// Nothing has launched yet: this is polled, so an absent dir is not an error.
		return [];
	}
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
			executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "light work", name: "one" },
						{ agent: "worker", task: "heavy work", name: "two" },
					],
				},
				{ count: 2 },
			),
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
		assert.match(text, /profile `light \(m-light, low\)`/, `the report never named the routed profile: ${text}`);
		assert.match(text, /profile `pro \(m-pro, high\)`/, `the report never named the routed profile: ${text}`);
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
				executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }),
			);
			const text = contentText(result);
			assert.match(text, /profile `current`/, `${label}: the report never named the current profile: ${text}`);
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
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }),
		);
		assert.equal(calls, 0, "routing ran without a configured key");
		assert.match(contentText(result), /profile `current`/);
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
		const result = await withSpawnHerdrStub(async () => {
			const pending = executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job" }] });
			await waitLaunched(h.cwd, 1);
			// Only the launch is bounded by the routing budget — the call itself now waits
			// for the child, so timing the whole call would measure the child's work.
			const launchedAfter = Date.now() - started;
			assert.ok(
				launchedAfter < 1000,
				`the child took ${launchedAfter}ms to launch — the routing budget did not bound the spawn`,
			);
			await settleSpawned(h.cwd, 1);
			return pending;
		});
		const text = contentText(result);
		assert.match(text, /profile `current`/, `the child did not spawn on current: ${text}`);
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
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }),
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
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job", profile: "light" }] }),
		);
		assert.match(contentText(result), /profile `light \(m-light, low\)`/);
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
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }),
		);
		assert.equal(factoryCalls, 0, "the route factory ran with routing off");
		assert.equal(routeCalls, 0, "the route ran with routing off");
		assert.match(contentText(result), /profile `current`/);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a role name in `profile` is treated as `current` when profiles are off", async () => {
	const config: TinysubagentConfig = { ...routingConfig(null), enableProfiles: false };
	const h = harness(config, () => async () => ({ choice: "light" }));
	try {
		const result = await withSpawnHerdrStub(() =>
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job", profile: "worker" }] }),
		);
		const text = contentText(result);
		assert.match(text, /profile `current`/, `the role name killed the batch: ${text}`);
		assert.doesNotMatch(text, /cannot be used/, `the role name was refused: ${text}`);
		assert.equal(writtenScripts(h.cwd).length, 1, "the subagent did not spawn");
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an unrelated named profile is still refused when profiles are off", async () => {
	const config: TinysubagentConfig = { ...routingConfig(null), enableProfiles: false };
	const h = harness(config, () => async () => ({ choice: "light" }));
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "one job", profile: "lite" }] }),
		);
		assert.match(contentText(result), /profiles are disabled/);
		assert.equal((result as { isError?: boolean }).isError, true);
		assert.equal(writtenScripts(h.cwd).length, 0, "a refused batch still spawned");
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// `classifierModel` alone keeps profile as an optional override
// ────────────────────────────────────────────────────────────────────────────

test("classifier routing announces the spawned subagent, not the router", async () => {
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
		await withSpawnHerdrStub(() => executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }));
		assert.deepEqual(h.notices, [{
			message: "tinysubagent: spawned Worker (worker) [light (by classifier model)] m-light (low)",
			level: "info",
		}]);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a batch of two announces both children, one line each", async () => {
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
		await withSpawnHerdrStub(() =>
			executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "one job", name: "first" },
						{ agent: "worker", task: "another job", name: "second" },
					],
				},
				{ count: 2 },
			),
		);
		assert.deepEqual(h.notices, [{
			message: [
				"tinysubagent: spawned 2 subagents",
				"  Worker (first) [light (by classifier model)] m-light (low)",
				"  Worker (second) [light (by classifier model)] m-light (low)",
			].join("\n"),
			level: "info",
		}]);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an explicit profile is announced without the classifier postfix", async () => {
	const config: TinysubagentConfig = {
		...routingConfig(null),
		classifier: {
			provider: "openrouter",
			model: "typesafe/jev-latest",
			raw: "openrouter/typesafe/jev-latest",
		},
	};
	const h = harness(config, () => async () => ({ choice: "pro" }));
	try {
		await withSpawnHerdrStub(() =>
			executeSettled(h, { tasks: [{ agent: "worker", task: "one job", profile: "light" }] }),
		);
		assert.deepEqual(h.notices, [{
			message: "tinysubagent: spawned Worker (worker) [light] m-light (low)",
			level: "info",
		}]);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("tool description says subagents start immediately and the call waits for them", () => {
	const config = routingConfig(null);
	const description = buildToolDescription([workerAgent], config);
	assert.match(description, /starts the requested subagent\(s\) immediately/);
	assert.match(description, /does not queue or defer them for later/);
	assert.match(description, /tasks` array with one or more subagents/);
	assert.doesNotMatch(description, /Modes: single/);
	assert.match(description, /All requested subagents run concurrently/);
	// With profiles on, the original `profile` advice stays.
	assert.match(description, /Specify `name` and `profile` per task when needed\./);
	// The delivery contract the model is told about: one blocking call, one result.
	assert.match(description, /returns when every subagent has finished/);
	assert.match(description, /reports come back together in a single result/);
});

test("with profiles off the description forbids `profile` and still lists the roles", () => {
	const config: TinysubagentConfig = { ...routingConfig(null), enableProfiles: false };
	const description = buildToolDescription([workerAgent], config);
	assert.doesNotMatch(description, /Specify `name` and `profile`/);
	assert.match(description, /a role name is never a `profile`/);
	assert.match(description, /profiles are disabled/);
	assert.match(description, /Available roles:/);
	assert.match(description, /- `worker`/);
	assert.ok(!JSON.stringify(buildParameters(config)).includes('"profile"'));
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
// The sharing gate: a knob the model is never offered when it is off
// ────────────────────────────────────────────────────────────────────────────

/** The task object's property names, as the model is offered them. */
function taskProperties(config: TinysubagentConfig): string[] {
	const schema = buildParameters(config) as unknown as {
		properties: { tasks: { items: { properties: Record<string, unknown> } } };
	};
	return Object.keys(schema.properties.tasks.items.properties);
}

test("`shareContext` is on the task object only when the gate is on", () => {
	const off: TinysubagentConfig = { ...routingConfig(null), canShareContext: false };
	const on: TinysubagentConfig = { ...off, canShareContext: true };

	assert.deepEqual(taskProperties(off), ["agent", "task", "name", "profile"]);
	assert.ok(taskProperties(on).includes("shareContext"));
});

test("pi-level validation still accepts a role name in `profile` with profiles off", () => {
	// pi validates every call against the schema before `execute` runs, so a closed
	// task object turned a benign extra key into a dead batch. The task object stays
	// open; a key the gate does not permit is refused by the tool body instead.
	const config: TinysubagentConfig = { ...routingConfig(null), enableProfiles: false, canShareContext: false };
	const call = { tasks: [{ agent: "worker", task: "x", profile: "worker" }] };

	assert.equal(Check(buildParameters(config), call), true);
});

test("the prompt stops claiming a subagent cannot see the conversation when sharing is available", () => {
	const off: TinysubagentConfig = { ...routingConfig(null), canShareContext: false };
	const on: TinysubagentConfig = { ...off, canShareContext: true };

	assert.match(buildToolDescription([workerAgent], off), /isolated context window/);
	assert.match(buildPromptGuidelines(off).join("\n"), /cannot see this conversation/);

	assert.doesNotMatch(buildToolDescription([workerAgent], on), /isolated context window/);
	assert.doesNotMatch(buildPromptGuidelines(on).join("\n"), /cannot see this conversation/);
	// The brief is still what the child answers to: sharing is background, not an
	// instruction, and the description names the knob the model may now set.
	assert.match(buildToolDescription([workerAgent], on), /`shareContext: true`/);
	assert.match(buildPromptGuidelines(on).join("\n"), /brief must still stand on its own/);
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

/** The label a launch script runs under: its own export, else the header comment. */
function nameFrom(script: string): string {
	const env = script.match(/export PI_TINYSUBAGENT_NAME='((?:[^']|'\\'')*)'/);
	if (env) return (env[1] ?? "").replaceAll("'\\''", "'");
	return script.match(/^# subagent: (.*)$/m)?.[1] ?? "unknown";
}

/** Wait until `count` launch scripts exist, without settling anything. */
async function waitLaunched(cwd: string, count: number): Promise<void> {
	await until(async () => writtenScripts(cwd).length >= count, `expected ${count} launch script(s)`);
}

/**
 * Settle every child by writing the report sidecar the watcher polls for, which
 * is exactly what a real child's `subagent_report` does. `count` is the TOTAL
 * number of scripts the test expects, so a second call can settle the first
 * batch's children along with its own.
 */
async function settleSpawned(cwd: string, count: number, text?: string): Promise<void> {
	await waitLaunched(cwd, count);
	for (const script of writtenScripts(cwd)) {
		const reportFile = reportFileFrom(script);
		if (existsSync(reportFile)) continue;
		writeFileSync(reportFile, JSON.stringify({ type: "done", result: text ?? `PONG from ${nameFrom(script)}` }));
	}
}

/** Settle every child as a failure: the ending that must still not be `isError`. */
async function failSpawned(cwd: string, count: number, message = "boom"): Promise<void> {
	await waitLaunched(cwd, count);
	for (const script of writtenScripts(cwd)) {
		const reportFile = reportFileFrom(script);
		if (existsSync(reportFile)) continue;
		writeFileSync(reportFile, JSON.stringify({ type: "failed", reason: "error", message }));
	}
}

/** Run a call that spawns children, settle the batch it launched, return the result. */
async function executeSettled(
	h: ReturnType<typeof harness>,
	params: unknown,
	options: { count?: number; text?: string } = {},
): Promise<unknown> {
	const pending = executeTool(h.tool, h.ctx, params);
	// Wait for the launch BEFORE settling: a report written while the call is still
	// opening panes would settle a child mid-batch and change what it returns.
	await settleSpawned(h.cwd, options.count ?? 1, options.text);
	return pending;
}

test("a later call can launch another subagent with the same running name", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const second = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "another job", name: "alpha" }],
			});
			await settleSpawned(h.cwd, 2);
			assert.match(contentText(await first), /## alpha — completed/);
			assert.match(contentText(await second), /## alpha — completed/);
			assert.equal(writtenScripts(h.cwd).length, 2, "the same-name request was not launched");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a batch launches same-name requests", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const result = await executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "another alpha job", name: "alpha" },
						{ agent: "worker", task: "a fresh job", name: "beta" },
					],
				},
				{ count: 3 },
			);
			const text = contentText(result);
			assert.match(text, /beta — completed/, `the fresh request never started: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 3, "the batch launched the wrong number of children");
			assert.notEqual(isErrorFlag(result), true, "the batch was reported as an error");

			await first;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a refused spawn remains reported", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			const result = await executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "another alpha job", name: "alpha" },
						{ agent: "missing-role", task: "refused", name: "beta" },
					],
				},
				{ count: 2 },
			);
			assert.match(contentText(result), /failed missing-role/);
			assert.notEqual(isErrorFlag(result), true, "a batch that launched a child was reported as a tool error");

			await first;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a call with names matching running subagents still launches them", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the first job", name: "alpha" },
					{ agent: "worker", task: "the second job", name: "beta" },
				],
			});
			await waitLaunched(h.cwd, 2);

			const result = await executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "another alpha job", name: "alpha" },
						{ agent: "worker", task: "another beta job", name: "beta" },
					],
				},
				{ count: 4 },
			);
			assert.equal(writtenScripts(h.cwd).length, 4, "the batch launched the wrong number of children");
			assert.notEqual(isErrorFlag(result), true, "the same-name batch was reported as an error");

			await first;
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

test("same-name requests are still routed and get their own Brief", async () => {
	const routed: string[] = [];
	const route: RouteFn = async (input) => {
		routed.push(input.task);
		return { choice: "light" };
	};
	const h = harness(routingConfig(systemOneOn), () => route);
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			routed.length = 0;

			const second = executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "a duplicate brief", name: "alpha" },
					{ agent: "worker", task: "a fresh brief", name: "beta" },
				],
			});
			await settleSpawned(h.cwd, 3);
			await second;
			await first;
			assert.deepEqual(routed, ["a duplicate brief", "a fresh brief"], "same-name request was not routed");
			const briefs = writtenBriefs(h.cwd);
			assert.equal(briefs.length, 3, "same-name request did not write a Brief");
			assert.ok(briefs.some((brief) => brief.includes("a duplicate brief")), "same-name brief was not written");
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

test("a label is free again once its subagent's wait ends", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			const another = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "another job", name: "alpha" }],
			});
			await settleSpawned(h.cwd, 2);
			await first;
			await another;
			const retry = await executeSettled(
				h,
				{ tasks: [{ agent: "worker", task: "work after the label was released", name: "alpha" }] },
				{ count: 3 },
			);
			assert.match(
				contentText(retry),
				/## alpha — completed/,
				"the retry failed after the earlier subagent stopped",
			);
			assert.equal(writtenScripts(h.cwd).length, 3, "the retry launched the wrong number of children");
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
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			const script = writtenScripts(h.cwd)[0] ?? assert.fail("no launch script was written");
			writeFileSync(reportFileFrom(script), JSON.stringify({ type: "done", result: "the first job is done" }));

			// The whole point of the refactor: the report comes back as the tool result.
			assert.match(
				contentText(await first),
				/the first job is done/,
				"the reported result never came back as the tool result",
			);

			const retry = await executeSettled(
				h,
				{ tasks: [{ agent: "worker", task: "work after the label was released", name: "alpha" }] },
				{ count: 2 },
			);
			assert.match(
				contentText(retry),
				/## alpha — completed/,
				"the label was still held after its subagent reported",
			);
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

			const retried = await executeSettled(h, {
				tasks: [{ agent: "worker", task: "the real job", name: "alpha" }],
			});
			const text = contentText(retried);
			assert.match(text, /## alpha — completed/, `the refused spawn kept its label: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 1, "the retry launched the wrong number of children");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("subagent names are display labels, not uniqueness constraints", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const both = executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the upper job", name: "Alpha" },
					{ agent: "worker", task: "the lower job", name: "alpha" },
				],
			});
			await waitLaunched(h.cwd, 2);

			const exact = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the duplicate job", name: "alpha" }],
			});
			await settleSpawned(h.cwd, 3);
			await exact;
			const text = contentText(await both);
			assert.doesNotMatch(text, /skipped/, `same-name requests were skipped: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 3, "same-name requests did not all launch");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an omitted name still defaults to the role name without reserving it", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job" }],
			});
			await waitLaunched(h.cwd, 1);

			const second = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job" }],
			});

			await settleSpawned(h.cwd, 2);
			assert.match(contentText(await first), /worker — completed/, "the default name was not the role name");
			await second;
			assert.equal(writtenScripts(h.cwd).length, 2, "the default-named child was not launched");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("suffixing distinct requests in a batch still works alongside a running name", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const result = await executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "a duplicate job", name: "alpha" },
						{ agent: "worker", task: "a suffixed job", name: "alpha" },
					],
				},
				{ count: 3 },
			);
			const text = contentText(result);
			assert.match(text, /alpha-2 — completed/, `the suffixed request never started: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 3, "the batch launched the wrong number of children");

			await first;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// The waiting call: what comes back, and what it never does to a pane
// ────────────────────────────────────────────────────────────────────────────

test("a failed child is content, not a tool error", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const pending = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a job that dies", name: "alpha" }],
			});
			await failSpawned(h.cwd, 1, "the child fell over");
			const result = await pending;

			const text = contentText(result);
			assert.match(text, /## alpha — failed \(error\)/, `the failure never reached the result: ${text}`);
			assert.match(text, /the child fell over/, `the failure was reported without its message: ${text}`);
			assert.notEqual(isErrorFlag(result), true, "a failed child was reported as a tool error, not content");
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"a failed child's pane was closed behind it",
			);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("aborting the call interrupts the batch and closes the pane", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const controller = new AbortController();
			const pending = executeTool(
				h.tool,
				h.ctx,
				{ tasks: [{ agent: "worker", task: "a job nobody waits for", name: "alpha" }] },
				controller.signal,
			);
			await waitLaunched(h.cwd, 1);

			controller.abort();
			const result = await pending;

			const text = contentText(result);
			assert.match(
				text,
				/## alpha — interrupted \(pane closed\)/,
				`the aborted child was not reported as interrupted: ${text}`,
			);
			assert.equal(text.includes("cancelled"), false, `an interrupted child was reported as cancelled: ${text}`);
			assert.notEqual(isErrorFlag(result), true, "interrupting a call was reported as a tool error");
			// The row still names the pane it came from, even though that pane is gone.
			const row = (result as { details?: { results?: { paneId?: string; cause?: string }[] } }).details
				?.results?.[0];
			assert.equal(row?.paneId, "w1:p1Z", "the interrupted row lost the pane it came from");
			assert.equal(row?.cause, "interrupt", `the row did not carry the interrupt as its cause: ${String(row?.cause)}`);
			// The relay closes the pane it just interrupted, once, without escalating.
			await until(async () => closeCalls(calls()).length >= 1, "the interrupted child's pane was left open");
			await quiet(calls);
			assert.deepEqual(closeCalls(calls()), ["pane close w1:p1Z"]);
			assert.equal(writtenScripts(h.cwd).length, 1, "the aborted call launched another child");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a reported completion closes the child's pane", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const result = await executeSettled(h, {
				tasks: [{ agent: "worker", task: "a job that reports", name: "alpha" }],
			});
			assert.match(contentText(result), /## alpha — completed \(reported\)/);
			// The child left under its own power, so there is nothing left to read.
			await until(
				async () => calls().some((line) => line.startsWith("pane close")),
				"a reported child's pane was left open",
			);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a turn-end completion leaves the pane open, since it is the only evidence", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const pending = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a job that never reported", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			// The content-free terminal a child writes once its reminder budget is
			// spent: the turn ended, the child is alive at its prompt, nothing was said.
			writeFileSync(reportFileFrom(writtenScripts(h.cwd)[0]!), '{"type":"done"}');
			const result = await pending;

			const text = contentText(result);
			assert.match(text, /## alpha — completed/, `the settle never reached the result: ${text}`);
			// The reader is told the child never reported and that the pane is still
			// there — not pointed at a pane this code had just closed.
			assert.match(text, /never reported/, `a summary-less completion went unexplained: ${text}`);
			assert.match(text, /pane is still open/, `the result did not say the pane was left open: ${text}`);

			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"a turn-end completion's pane was closed, destroying the only evidence of what it did",
			);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a spawn that throws after opening a pane degrades to a partial batch", async () => {
	// A tracker that fails the second time it is asked to record a pane: the pane is
	// already open by then, which is the case that used to strand a whole batch.
	const columns = new LiveSubPanes();
	const place = columns.place.bind(columns);
	let placements = 0;
	columns.place = (paneId: string): void => {
		placements += 1;
		if (placements >= 2) throw new Error("layout tracker exploded");
		place(paneId);
	};

	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }), { columns });
	try {
		await withSpawnHerdrStub(async () => {
			const pending = executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the job that starts", name: "alpha" },
					{ agent: "worker", task: "the job that throws", name: "beta" },
				],
			});
			await waitLaunched(h.cwd, 1);
			await settleSpawned(h.cwd, 1);
			const result = await pending;

			// The child that did start is reported, not orphaned by its sibling's throw.
			const text = contentText(result);
			assert.match(text, /## alpha — completed \(reported\)/, `the started child was lost: ${text}`);
			assert.match(text, /failed worker: layout tracker exploded/, `the throw never reached the result: ${text}`);
			assert.notEqual(isErrorFlag(result), true, "a partly started batch was reported as a tool error");

			const details = (result as { details?: { status?: string; results?: unknown[]; failed?: { error: string }[] } }).details;
			assert.equal(details?.status, "finished");
			assert.equal(details?.results?.length, 1, "the failed spawn appeared as a result of its own");
			assert.equal(details?.failed?.[0]?.error, "layout tracker exploded");
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// An interrupt relays Esc into every live child pane, then closes it
// ────────────────────────────────────────────────────────────────────────────

/** The `pane send-keys` commands the tool issued, in order. */
function sendKeyCalls(calls: readonly string[]): string[] {
	return calls.filter((line) => line.startsWith("pane send-keys"));
}

/** The `pane close` commands the tool issued, in order. */
function closeCalls(calls: readonly string[]): string[] {
	return calls.filter((line) => line.startsWith("pane close"));
}

/**
 * Wait until the relay's fire-and-forget sends have all landed: the command log
 * must stay unchanged for a quiet window before the test reads it. A fixed sleep
 * would be either flaky or slow, since a cold `execFile` takes a while.
 */
async function quiet(calls: () => string[], timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let seen = -1;
	while (Date.now() < deadline) {
		const now = calls().length;
		if (now === seen) return;
		seen = now;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("the herdr command log never stopped changing");
}

test("aborting a waiting call relays exactly one Esc into its child's pane", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const controller = new AbortController();
			const pending = executeTool(
				h.tool,
				h.ctx,
				{ tasks: [{ agent: "worker", task: "a job whose turn ends early", name: "alpha" }] },
				controller.signal,
			);
			await waitLaunched(h.cwd, 1);

			controller.abort();
			assert.match(contentText(await pending), /alpha — interrupted \(pane closed\)/);

			// The relay is issued without await, so poll for it rather than racing it.
			await until(async () => sendKeyCalls(calls()).length >= 1, "the interrupt never reached the child's pane");
			await quiet(calls);
			assert.deepEqual(sendKeyCalls(calls()), ["pane send-keys w1:p1Z esc"]);
			// Every id the Esc went into is closed behind it, once.
			assert.deepEqual(closeCalls(calls()), ["pane close w1:p1Z"]);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an abort closes every live child pane, including an earlier call's", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const earlier = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the earlier call's job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const controller = new AbortController();
			const later = executeTool(
				h.tool,
				h.ctx,
				{ tasks: [{ agent: "worker", task: "the later call's job", name: "beta" }] },
				controller.signal,
			);
			await waitLaunched(h.cwd, 2);
			// Both calls are past their spawn loop and blocking, so both panes are
			// tracked: the fan-out below is the interrupt's, not a spawn race.
			await until(async () => h.watching() >= 2, "the two calls never reached their waits");

			controller.abort();
			await later;

			await until(async () => sendKeyCalls(calls()).length >= 2, "the fan-out never reached both children");
			await quiet(calls);
			assert.deepEqual(sendKeyCalls(calls()).sort(), [
				"pane send-keys w1:p1Z esc",
				"pane send-keys w1:p2Z esc",
			]);
			// The earlier call's child was interrupted too, so its pane is closed by the
			// same relay — not left alive with nothing driving it.
			assert.deepEqual(closeCalls(calls()).sort(), ["pane close w1:p1Z", "pane close w1:p2Z"]);

			h.settleAll();
			await earlier;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a pane dropped from the tracker is neither relayed to nor closed", async () => {
	const columns = new LiveSubPanes();
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }), { columns });
	try {
		await withSpawnHerdrStub(async (calls) => {
			const controller = new AbortController();
			const pending = executeTool(
				h.tool,
				h.ctx,
				{ tasks: [{ agent: "worker", task: "a job nobody waits for", name: "alpha" }] },
				controller.signal,
			);
			await waitLaunched(h.cwd, 1);
			await until(async () => h.watching() >= 1, "the child's wait was never registered");

			// A pane this registration has forgotten: the relay must read the
			// tracker, not rediscover the tab, so a gone child is never typed into.
			columns.place("w1:p7Z");
			columns.drop("w1:p7Z");

			controller.abort();
			await pending;

			await until(async () => sendKeyCalls(calls()).length >= 1, "the live child was never relayed to");
			await quiet(calls);
			assert.deepEqual(sendKeyCalls(calls()), ["pane send-keys w1:p1Z esc"]);
			// A pane this registration already forgot is not ours to close either.
			assert.deepEqual(closeCalls(calls()), ["pane close w1:p1Z"]);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a relay that fails is silent and does not stop the rest of the fan-out", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(
			async (calls) => {
				const controller = new AbortController();
				const pending = executeTool(
					h.tool,
					h.ctx,
					{
						tasks: [
							{ agent: "worker", task: "the first job", name: "alpha" },
							{ agent: "worker", task: "the second job", name: "beta" },
						],
					},
					controller.signal,
				);
				await waitLaunched(h.cwd, 2);
				await until(async () => h.watching() >= 2, "the batch never reached its wait");

				controller.abort();
				const result = await pending;

				await until(async () => sendKeyCalls(calls()).length >= 2, "a failed relay stopped the fan-out");
				await quiet(calls);
				assert.deepEqual(sendKeyCalls(calls()).sort(), [
					"pane send-keys w1:p1Z esc",
					"pane send-keys w1:p2Z esc",
				]);
				// A failed Esc does not stop the close: both interrupted panes are closed.
				assert.deepEqual(closeCalls(calls()).sort(), ["pane close w1:p1Z", "pane close w1:p2Z"]);

				const text = contentText(result);
				assert.match(text, /alpha — interrupted/, "the failed relay changed the result");
				assert.match(text, /beta — interrupted/, "the failed relay changed the result");
				assert.notEqual(isErrorFlag(result), true, "a pane that is gone turned the interrupt into a failure");
				assert.deepEqual(
					h.notices.filter((notice) => notice.level !== "info"),
					[],
					"a failed relay warned the operator",
				);
				assert.equal(writtenScripts(h.cwd).length, 2, "a failed relay changed what was spawned");
			},
			{ failSendKeys: ["w1:p1Z"] },
		);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a second Esc is a no-op: no second relay and no second close", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async (calls) => {
			const controller = new AbortController();
			const pending = executeTool(
				h.tool,
				h.ctx,
				{ tasks: [{ agent: "worker", task: "a job with two Escapes", name: "alpha" }] },
				controller.signal,
			);
			await waitLaunched(h.cwd, 1);
			await until(async () => h.watching() >= 1, "the child's wait was never registered");

			controller.abort();
			await pending;
			// The call has already aborted; a second Esc asks for nothing new.
			controller.abort();
			h.settleAll();
			await quiet(calls);

			assert.deepEqual(sendKeyCalls(calls()), ["pane send-keys w1:p1Z esc"]);
			// One interrupt, one close: the second Esc adds nothing, and nothing re-closes.
			assert.deepEqual(closeCalls(calls()), ["pane close w1:p1Z"]);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an abort mid-spawn leaves the remaining requests unlaunched and their labels free", async () => {
	const gateDir = mkdtempSync(join(tmpdir(), "tinysubagent-tool-gate-"));
	const gate = join(gateDir, "open");
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(
			async (calls) => {
				const controller = new AbortController();
				const pending = executeTool(
					h.tool,
					h.ctx,
					{
						tasks: [
							{ agent: "worker", task: "the job that starts", name: "alpha" },
							{ agent: "worker", task: "the job that never starts", name: "beta" },
						],
					},
					controller.signal,
				);

				// The stub holds `plugin pane open` until the gate exists, so the abort
				// lands while the first spawn is genuinely in flight — not on a sleep.
				await waitLaunched(h.cwd, 1);
				controller.abort();
				writeFileSync(gate, "");
				const result = await pending;

				assert.equal(writtenScripts(h.cwd).length, 1, "the aborted batch launched its remaining request");
				await until(async () => sendKeyCalls(calls()).length >= 1, "the child that opened during the abort got no Esc");
				await quiet(calls);
				assert.deepEqual(sendKeyCalls(calls()), ["pane send-keys w1:p1Z esc"]);
				assert.deepEqual(closeCalls(calls()), ["pane close w1:p1Z"]);
				assert.match(contentText(result), /alpha — interrupted/);

				// Nothing reserved the unlaunched request's name: a later call can use it.
				const retry = await executeSettled(
					h,
					{ tasks: [{ agent: "worker", task: "the retried job", name: "beta" }] },
					{ count: 2 },
				);
				assert.match(
					contentText(retry),
					/## beta — completed/,
					"the unlaunched request's label was never released",
				);
			},
			{ holdPaneOpenUntil: gate },
		);
	} finally {
		h.stop();
		h.cleanup();
		rmSync(gateDir, { recursive: true, force: true });
	}
});

// ────────────────────────────────────────────────────────────────────────────
// A share reaches the child as a fork of this conversation, or not at all
// ────────────────────────────────────────────────────────────────────────────

/** The child session files this batch left behind, under the project agent dir. */
function childSessionFiles(cwd: string): string[] {
	const sessions = join(cwd, ".pi", "agent", "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(sessions, file));
}

/** The branch this conversation holds when `subagent` is called. */
function orchestratorBranch(): SessionEntry[] {
	const at = "2026-11-23T06:00:00.000Z";
	const entry = (id: string, parentId: string | null, role: string, content: unknown): SessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: { role, content } as never,
	});
	return [
		entry("s1", null, "system", ""),
		entry("u1", "s1", "user", "ship the thing"),
		entry("a1", "u1", "assistant", "on it"),
		entry("u2", "a1", "user", "delegate the rest"),
		entry("a2", "u2", "assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
	];
}

test("a shared task hands the child a fork of this conversation", async () => {
	const config: TinysubagentConfig = { ...routingConfig(null), canShareContext: true };
	const h = harness(config, () => async () => ({ choice: "current" }), { branch: orchestratorBranch() });
	try {
		await withSpawnHerdrStub(() =>
			executeSettled(h, { tasks: [{ agent: "worker", task: "the rest", shareContext: true }] }),
		);
		const [file] = childSessionFiles(h.cwd);
		assert.ok(file, "the child was given no session file at all");
		const [headerLine, ...entryLines] = readFileSync(file, "utf8").trimEnd().split("\n");
		const header = JSON.parse(headerLine ?? "") as { id: string; cwd: string; parentSession: string };
		assert.equal(header.parentSession, join(h.cwd, "sessions", "sid.jsonl"));
		assert.equal(header.cwd, h.cwd);
		assert.equal(header.id, file.split("/").pop()?.replace(/\.jsonl$/, "").split("_").slice(1).join("_"));
		// The child answers to the brief, so the share stops before the delegation.
		const entries = entryLines.map((line) => JSON.parse(line) as { message?: { role: string } });
		assert.equal(entries.at(-1)?.message?.role, "user");
		assert.equal(entries.some((entry) => entry.message?.role === "system"), false);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("with the gate off a `shareContext` call is refused by name and opens no pane", async () => {
	// The schema merely omits the key, so a stray `shareContext` still reaches
	// `execute` (pi must never fail a whole batch over a benign extra key). The
	// refusal therefore happens here, before any child launches, and names the gate
	// and the file that would set it.
	const h = harness(routingConfig(null), () => async () => ({ choice: "current" }), { branch: orchestratorBranch() });
	try {
		const result = await withSpawnHerdrStub(() =>
			executeTool(h.tool, h.ctx, { tasks: [{ agent: "worker", task: "the rest", shareContext: true }] }),
		);
		const text = contentText(result);
		assert.equal(isErrorFlag(result), true, `a share the gate refuses was accepted: ${text}`);
		assert.match(text, /canShareContext/, `the refusal did not name the gate: ${text}`);
		assert.match(text, /tinysubagent\.json/, `the refusal did not name the config file: ${text}`);
		assert.equal(writtenScripts(h.cwd).length, 0, "a refused share still spawned");
		assert.deepEqual(childSessionFiles(h.cwd), []);
	} finally {
		h.stop();
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// A share the child cannot be given fails that request, not the batch
// ────────────────────────────────────────────────────────────────────────────

/**
 * The labels a batch left behind under `sessionDir`, for one kind of artifact:
 * a script or a brief, named `<label>-<id>(-<stamp>).(sh|md)`. The refused
 * request's label must not appear in either list.
 */
function leavings(sessionDir: string, kind: "context" | "subagent-scripts"): string[] {
	try {
		return readdirSync(join(sessionDir, "artifacts", "sid", kind)).map((file) =>
			file.replace(/-[0-9a-f]{8}(-.*)?\.(sh|md)$/, ""),
		);
	} catch {
		return [];
	}
}

/**
 * Settle children as they launch, until the call returns. A refused request
 * never writes a launch script, so counting scripts up front would either settle
 * too few or wait for a child that was never meant to exist.
 */
async function settleAsTheyLaunch(pending: Promise<unknown>, cwd: string, text = "PONG"): Promise<unknown> {
	let settled = false;
	const done = pending.then((result) => {
		settled = true;
		return result;
	});
	while (!settled) {
		for (const script of writtenScripts(cwd)) {
			const reportFile = reportFileFrom(script);
			if (!existsSync(reportFile)) writeFileSync(reportFile, JSON.stringify({ type: "done", result: text }));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return done;
}

test("a share on an agy profile fails that request and its sibling spawns untouched", async () => {
	// agy keeps no session file, so there is nothing to fork into. The brief of
	// that request was written as if the child knows this conversation, so a clean
	// child is the wrong spawn — while the sibling is still exactly what was asked
	// for.
	const base = routingConfig(null);
	const config: TinysubagentConfig = {
		...base,
		canShareContext: true,
		profiles: { ...base.profiles, gemini: { harness: "agy", model: "gpt-oss-120b" } },
	};
	const h = harness(config, () => async () => ({ choice: "current" }), { branch: orchestratorBranch() });
	try {
		const result = await withSpawnHerdrStub(() =>
			settleAsTheyLaunch(
				executeTool(h.tool, h.ctx, {
					tasks: [
						{ agent: "worker", task: "the agy one", name: "shared-agy", profile: "gemini", shareContext: true },
						{ agent: "worker", task: "the sibling", name: "plain" },
					],
				}),
				h.cwd,
				"PONG from plain",
			),
		);
		const text = contentText(result);
		assert.match(text, /failed worker: .*agy harness/, `the refusal did not name the harness: ${text}`);
		assert.match(text, /## plain — completed/);
		// The sibling launched exactly as it would have: one script, one brief — and
		// nothing at all named after the refused request, fork included.
		assert.deepEqual(leavings(join(h.cwd, "sessions"), "subagent-scripts"), ["plain"]);
		assert.deepEqual(leavings(join(h.cwd, "sessions"), "context"), ["plain"]);
		assert.deepEqual(childSessionFiles(h.cwd), []);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a share is refused when this session has no file to fork, and its sibling spawns untouched", async () => {
	// `--no-session`: there is no branch on disk to fork, and a silent clean child
	// would answer a brief written as if it had read this conversation.
	const config: TinysubagentConfig = { ...routingConfig(null), canShareContext: true };
	const h = harness(config, () => async () => ({ choice: "current" }), {
		branch: orchestratorBranch(),
		sessionFile: null,
	});
	// Without a session file the artifacts are planned under the agent dir, so it is
	// pointed at the scratch project: nothing this test writes can land in the real one.
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = h.cwd;
	try {
		const result = await withSpawnHerdrStub(() =>
			settleAsTheyLaunch(
				executeTool(h.tool, h.ctx, {
					tasks: [
						{ agent: "worker", task: "the shared one", name: "shared", shareContext: true },
						{ agent: "worker", task: "the sibling", name: "plain" },
					],
				}),
				h.cwd,
				"PONG from plain",
			),
		);
		const text = contentText(result);
		assert.match(text, /failed worker: .*no session file/, `the refusal did not name the cause: ${text}`);
		assert.match(text, /## plain — completed/);
		assert.deepEqual(leavings(join(h.cwd, "sessions"), "subagent-scripts"), ["plain"]);
		assert.deepEqual(leavings(join(h.cwd, "sessions"), "context"), ["plain"]);
		assert.deepEqual(childSessionFiles(h.cwd), []);
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		h.stop();
		h.cleanup();
	}
});
