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
function harness(
	config: TinysubagentConfig,
	route: (ctx: ExtensionContext) => RouteFn,
	options: { columns?: LiveSubPanes } = {},
) {
	const watchers = new Set<AbortController>();
	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config),
		advertisedAgents: [workerAgent],
		capability: { ensureReady: async () => null },
		columns: options.columns ?? new LiveSubPanes(),
		runningLabels: new RunningLabels(),
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
			// A shutdown ends the blocking waits; the panes are left open.
			for (const controller of watchers) controller.abort();
		},
		/** End every running child's wait, as a shutdown or a vanished pane would. */
		settleAll: () => {
			for (const controller of watchers) controller.abort();
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
		await withSpawnHerdrStub(() => executeSettled(h, { tasks: [{ agent: "worker", task: "one job" }] }));
		assert.deepEqual(h.notices, [{
			message: "tinysubagent: routing profile with classifier model openrouter/typesafe/jev-latest.",
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
	// The delivery contract the model is told about: one blocking call, one result.
	assert.match(description, /returns when every subagent has finished/);
	assert.match(description, /reports come back together in a single result/);
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
	// reserving labels would release them mid-batch and make the skip tests racy.
	await settleSpawned(h.cwd, options.count ?? 1, options.text);
	return pending;
}

test("a later call reusing a running label is skipped and launches nothing", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const second = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job", name: "alpha" }],
			});
			const text = contentText(second);
			assert.match(text, /alpha/, `the skip notice never named the running label: ${text}`);
			assert.notEqual(isErrorFlag(second), true, "a skip-only call was reported as a tool error");
			assert.equal(writtenScripts(h.cwd).length, 1, "the duplicate request launched a second child");

			await settleSpawned(h.cwd, 1);
			assert.match(contentText(await first), /## alpha — completed/, "the first spawn never started");
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
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);

			const result = await executeSettled(
				h,
				{
					tasks: [
						{ agent: "worker", task: "a duplicate job", name: "alpha" },
						{ agent: "worker", task: "a fresh job", name: "beta" },
					],
				},
				{ count: 2 },
			);
			const text = contentText(result);
			assert.match(text, /skipped alpha/, `the skip notice never named the running label: ${text}`);
			assert.match(text, /## beta — completed/, `the fresh request never started: ${text}`);
			assert.doesNotMatch(text, /## alpha — /, "the duplicate request spawned a child anyway");
			assert.equal(writtenScripts(h.cwd).length, 2, "the batch launched the wrong number of children");
			assert.notEqual(isErrorFlag(result), true, "a partly skipped batch was reported as an error");

			await first;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a skipped request does not hide a refused spawn in the same batch", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			const result = await executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "duplicate", name: "alpha" },
					{ agent: "missing-role", task: "refused", name: "beta" },
				],
			});
			assert.match(contentText(result), /skipped alpha/);
			assert.match(contentText(result), /failed missing-role/);
			assert.equal(isErrorFlag(result), true, "the refused spawn was hidden by the skipped request");

			await settleSpawned(h.cwd, 1);
			await first;
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
			const first = executeTool(h.tool, h.ctx, {
				tasks: [
					{ agent: "worker", task: "the first job", name: "alpha" },
					{ agent: "worker", task: "the second job", name: "beta" },
				],
			});
			await waitLaunched(h.cwd, 2);

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

			await settleSpawned(h.cwd, 2);
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

test("a skipped request is never routed and never gets a Brief", async () => {
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
			await settleSpawned(h.cwd, 2);
			await second;
			await first;
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

test("a label is free again once its subagent's wait ends", async () => {
	const h = harness(routingConfig(null), () => async () => ({ choice: "light" }));
	try {
		await withSpawnHerdrStub(async () => {
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job", name: "alpha" }],
			});
			await waitLaunched(h.cwd, 1);
			const blocked = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job", name: "alpha" }],
			});
			assert.match(contentText(blocked), /skipped alpha/, "the label was not held while the child ran");

			// The wait is registered only after the spawn, so settling before it exists
			// would leave the child running until the never-started grace expires.
			await until(async () => h.watching() >= 1, "the child's wait was never registered");
			h.settleAll();
			await first;
			const retry = await executeSettled(
				h,
				{ tasks: [{ agent: "worker", task: "work after the label was released", name: "alpha" }] },
				{ count: 2 },
			);
			assert.match(
				contentText(retry),
				/## alpha — completed/,
				"the label was still held after its subagent stopped",
			);
			assert.equal(writtenScripts(h.cwd).length, 2, "the retry launched the wrong number of children");
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

test("labels match exactly and case-sensitively", async () => {
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

			const exact = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the duplicate job", name: "alpha" }],
			});
			assert.match(contentText(exact), /skipped alpha/, "an exact reuse of a running label was not skipped");

			await settleSpawned(h.cwd, 2);
			const text = contentText(await both);
			assert.doesNotMatch(text, /skipped/, `two distinct labels were treated as one: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "a batch with two distinct labels did not start both children");
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
			const first = executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "the first job" }],
			});
			await waitLaunched(h.cwd, 1);

			const second = await executeTool(h.tool, h.ctx, {
				tasks: [{ agent: "worker", task: "a duplicate job" }],
			});
			assert.match(
				contentText(second),
				/skipped worker/,
				"a default-labelled spawn was not checked against the running label",
			);

			await settleSpawned(h.cwd, 1);
			assert.match(contentText(await first), /## worker — completed/, "the default label was not the role name");
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
				{ count: 2 },
			);
			const text = contentText(result);
			assert.match(text, /skipped alpha/, `the first request was not skipped: ${text}`);
			assert.match(text, /## alpha-2 — completed/, `the suffixed request never started: ${text}`);
			assert.equal(writtenScripts(h.cwd).length, 2, "the batch launched the wrong number of children");

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

test("aborting the call interrupts the batch and leaves the pane open", async () => {
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
				/## alpha — interrupted \(pane left open\)/,
				`the aborted child was not reported as interrupted: ${text}`,
			);
			assert.equal(text.includes("cancelled"), false, `an interrupted child was reported as cancelled: ${text}`);
			assert.notEqual(isErrorFlag(result), true, "interrupting a call was reported as a tool error");
			// Give a stray close the chance to happen before asserting it never did.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"aborting the call closed the child's pane",
			);
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
// An interrupt relays Esc into every live child pane
// ────────────────────────────────────────────────────────────────────────────

/** The `pane send-keys` commands the tool issued, in order. */
function sendKeyCalls(calls: readonly string[]): string[] {
	return calls.filter((line) => line.startsWith("pane send-keys"));
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
			assert.match(contentText(await pending), /alpha — interrupted \(pane left open\)/);

			// The relay is issued without await, so poll for it rather than racing it.
			await until(async () => sendKeyCalls(calls()).length >= 1, "the interrupt never reached the child's pane");
			await quiet(calls);
			assert.deepEqual(sendKeyCalls(calls()), ["pane send-keys w1:p1Z esc"]);
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"the relay closed a pane instead of only interrupting it",
			);
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("an abort relays into every live child pane, including an earlier call's", async () => {
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
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"the relay closed a pane instead of only interrupting it",
			);

			h.settleAll();
			await earlier;
		});
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a pane dropped from the tracker is not relayed to", async () => {
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

				const text = contentText(result);
				assert.match(text, /alpha — interrupted/, "the failed relay changed the result");
				assert.match(text, /beta — interrupted/, "the failed relay changed the result");
				assert.notEqual(isErrorFlag(result), true, "a pane that is gone turned the interrupt into a failure");
				assert.deepEqual(h.notices, [], "a failed relay warned the operator");
				assert.equal(writtenScripts(h.cwd).length, 2, "a failed relay changed what was spawned");
			},
			{ failSendKeys: ["w1:p1Z"] },
		);
	} finally {
		h.stop();
		h.cleanup();
	}
});

test("a second Esc is a no-op and never escalates to closing the pane", async () => {
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
			assert.ok(
				!calls().some((line) => line.startsWith("pane close")),
				"the second Esc escalated to closing the pane",
			);
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
				assert.match(contentText(result), /alpha — interrupted/);

				// The unlaunched request's Label is free: a later call can reserve it.
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
