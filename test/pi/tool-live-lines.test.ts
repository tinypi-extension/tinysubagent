/**
 * The live lines a plain-terminal batch draws through the tool's partial channel.
 *
 * The supervisor is in memory: `execute` spawns no process, and the child's
 * stdout is a string the test hands to the subscriber the seam recorded. The
 * ticker is the test's too, so a redraw happens when the test asks for one; no
 * assertion here depends on the constant that spaces redraws.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { LiveSubPanes } from "../../src/pane-host/index.ts";
import type { PlainSupervisor } from "../../src/pane-host/plain.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import { createTool, type ToolDeps } from "../../src/pi/tool.ts";
import type { CapabilityCheck, Supervisor, SupervisorHandle } from "../../src/pane-host/index.ts";
import type { TinysubagentConfig } from "../../src/config/config.ts";
import type { RunningSubagent } from "../../src/children/watcher.ts";
import { buildParameters } from "../../src/present/describe.ts";
import type { LiveTicker } from "../../src/pi/live-lines.ts";
import type { AckDetails } from "../../src/present/ack-render.ts";
import type { AgentDef } from "../../src/types.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const MARKER = "live-stream-marker";
const REPORT = "the child's finished report";

const config: TinysubagentConfig = {
	enableProfiles: false,
	profiles: {},
	env: {},
	systemOne: null,
	classifier: null,
	sources: [],
};

const workerAgent: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	source: "user",
	path: "/tmp/worker.md",
};

interface PartialUpdate {
	content: { type: string; text?: string }[];
	details: { status?: string; live?: string[] };
}

/** A ticker the test drives, so no live-line assertion sleeps through a cadence. */
function manualTicker(): { every: LiveTicker; fire: () => void } {
	const ticks: (() => void)[] = [];
	return {
		every: (_ms, tick) => {
			ticks.push(tick);
			return () => {};
		},
		fire: () => {
			for (const tick of [...ticks]) tick();
		},
	};
}

/** The plain kind, with the child's stdout handed to the test instead of a pipe. */
interface FakePlain {
	supervisor: PlainSupervisor;
	/** The subscriber for one child, addressed by the label its spawn carried. */
	reader(label: string): (chunk: string) => void;
	readers: Map<string, (chunk: string) => void>;
	unsubscribed: number;
}

function fakePlain(): FakePlain {
	const readers = new Map<string, (chunk: string) => void>();
	const labels = new Map<string, string>();
	const record = { unsubscribed: 0 };
	let next = 0;

	const supervisor: PlainSupervisor = {
		kind: "plain",
		detectedIn: () => true,
		createCapability: (): CapabilityCheck => ({
			ensureReady: async () => null,
			probe: async () => ({ problem: null, fix: null }),
			reset: () => {},
		}),
		open: async (request) => {
			const id = `plain-${++next}`;
			labels.set(id, request.label ?? id);
			return { supervisor, id };
		},
		ended: async () => false,
		stop: async () => {},
		close: async () => true,
		output: (child: SupervisorHandle, onText: (chunk: string) => void) => {
			const label = labels.get(child.id) ?? child.id;
			readers.set(label, onText);
			return () => {
				readers.delete(label);
				record.unsubscribed += 1;
			};
		},
		// This kind's own streams, present rather than optional: nothing here reads
		// them, but the supervisor a plain terminal gets always has them.
		stderr: () => "",
		exitCode: () => null,
	};

	return {
		supervisor,
		readers,
		reader(label) {
			const reader = readers.get(label);
			assert.ok(reader, `no output subscriber for ${label}`);
			return reader;
		},
		get unsubscribed() {
			return record.unsubscribed;
		},
	};
}

/** The smallest `ExtensionAPI` the tool body touches. */
function stubPi(): ExtensionAPI {
	return {
		on() {},
		registerTool() {},
		sendMessage() {},
		getAllTools() {
			return [];
		},
	} as never;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface Harness {
	tool: ReturnType<typeof createTool>;
	cwd: string;
	updates: PartialUpdate[];
	watchers: Set<AbortController>;
	/** Collects the batch result, without settling it: the test decides how it ends. */
	run(params: unknown): Promise<unknown>;
	cleanup(): void;
}

function harness(supervisor: Supervisor, live: ToolDeps["live"]): Harness {
	const watchers = new Set<AbortController>();
	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config) as TSchema,
		advertisedAgents: [workerAgent],
		capability: { ensureReady: async () => null },
		columns: new LiveSubPanes(),
		watchers,
		supervisor,
		live,
		mode: "headless",
		route: () => async () => ({ choice: "current" }),
	});

	const cwd = mkdtempSync(join(tmpdir(), "tinysubagent-live-lines-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "agents", "worker.md"),
		"---\nname: worker\ndescription: does work\n---\nYou work.\n",
	);

	const ctx = {
		cwd,
		ui: { notify() {} },
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionFile: () => join(cwd, "sessions", "sid.jsonl"),
			getSessionId: () => "sid",
			buildContextEntries: () => [],
			getHeader: () => ({ type: "session", id: "sid", timestamp: "2026-11-24T00:00:00.000Z", cwd, version: 3 }),
		},
	};

	const updates: PartialUpdate[] = [];
	const execute = tool.execute as unknown as (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: (update: PartialUpdate) => void,
		ctx: unknown,
	) => Promise<unknown>;

	return {
		tool,
		cwd,
		updates,
		watchers,
		run: (params) => execute("call-1", params, undefined, (update) => updates.push(update), ctx),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

/**
 * Resolve the batch by giving every child a report, as a real child would.
 *
 * The report path is the one the generated launch script exports; a fake spawn
 * runs no script, so the test reads it back rather than guessing a timestamp.
 */
function reportEveryChild(cwd: string): void {
	const scripts = join(cwd, "sessions", "artifacts", "sid", "subagent-scripts");
	for (const file of filesWithSuffix(scripts, ".sh")) {
		const report = /PI_TINYSUBAGENT_REPORT='([^']+)'/.exec(readFileSync(file, "utf8"))?.[1];
		assert.ok(report, `no report path in ${file}`);
		writeFileSync(report, JSON.stringify({ type: "done", result: `${REPORT} ${basename(file)}` }));
	}
}

function filesWithSuffix(dir: string, suffix: string): string[] {
	const found: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesWithSuffix(path, suffix));
		else if (entry.name.endsWith(suffix)) found.push(path);
	}
	return found;
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** One `message_update` record carrying an assistant text delta, as pi frames it. */
function textDelta(delta: string): string {
	return `${JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	})}\n`;
}

const TASKS = ["alpha", "beta", "gamma", "delta"];

function batch(names: readonly string[]) {
	return { tasks: names.map((name) => ({ agent: "worker", task: `task ${name}`, name })) };
}

// ────────────────────────────────────────────────────────────────────────────
// The batch view
// ────────────────────────────────────────────────────────────────────────────

test("a four-child batch draws four lines, each opened by its ack, and the report keeps none of it", async () => {
	const fake = fakePlain();
	const ticker = manualTicker();
	const h = harness(fake.supervisor, { every: ticker.every, now: () => 0 });
	try {
		const done = h.run(batch(TASKS));
		await until(() => fake.readers.size === TASKS.length, 10_000);

		assert.equal(h.updates.length, 1, "the spawn was not acknowledged by one view");
		const first = h.updates[0]?.details.live ?? [];
		assert.equal(first.length, TASKS.length);
		assert.deepEqual(
			first.map((line) => line.split(" · ")[0]),
			TASKS.map((name) => `Worker (${name}) [current]`),
			"a line does not open with the child's ack",
		);

		// The child's stdout is driven while the view stays still: the drain never draws.
		for (const name of TASKS) fake.reader(name)(textDelta(`${MARKER} ${name}\n`));
		assert.equal(h.updates.length, 1, "a streamed chunk redrew the view");

		ticker.fire();
		assert.equal(h.updates.length, 2, "one tick drew more than one view");
		const streamed = h.updates[1]?.details.live ?? [];
		assert.deepEqual(
			streamed.map((line) => line.split(" · ").at(-1)),
			TASKS.map((name) => `${MARKER} ${name}`),
		);

		reportEveryChild(h.cwd);
		const result = (await done) as {
			content: { type: string; text?: string }[];
			details: Record<string, unknown>;
		};

		const text = result.content[0]?.text ?? "";
		assert.match(text, new RegExp(REPORT), "the batch result is not the report");
		assert.doesNotMatch(text, new RegExp(MARKER), "streamed text leaked into the tool result");
		assert.doesNotMatch(JSON.stringify(result.details), new RegExp(MARKER));
		assert.equal("live" in result.details, false, "the finished result carries a live view");
		assert.deepEqual(h.updates.at(-1)?.details.live, [], "the live view was not cleared");

		const rendered = h.tool.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false } as never,
			theme as never,
			{} as never,
		);
		assert.doesNotMatch((rendered?.render(200) ?? []).join("\n"), new RegExp(MARKER));

		assert.equal(fake.unsubscribed, TASKS.length, "a child's stream stayed subscribed after it settled");
	} finally {
		for (const controller of h.watchers) controller.abort("shutdown");
		h.cleanup();
	}
});

test("a one-child batch draws one line, and the spawn is acknowledged before any text arrives", async () => {
	const fake = fakePlain();
	const ticker = manualTicker();
	const h = harness(fake.supervisor, { every: ticker.every, now: () => 0 });
	try {
		const done = h.run(batch(["solo"]));
		await until(() => fake.readers.size === 1, 10_000);
		assert.deepEqual(h.updates[0]?.details.live, ["Worker (solo) [current] · 0s"]);

		for (const controller of h.watchers) controller.abort("shutdown");
		await done;

		assert.deepEqual(h.updates.at(-1)?.details.live, []);
	} finally {
		for (const controller of h.watchers) controller.abort("shutdown");
		h.cleanup();
	}
});

test("a call that launched nothing draws no live line", async () => {
	const fake = fakePlain();
	const ticker = manualTicker();
	const h = harness(fake.supervisor, { every: ticker.every, now: () => 0 });
	try {
		const result = (await h.run({ tasks: [{ agent: "absent-role", task: "nothing", name: "nobody" }] })) as {
			isError?: boolean;
		};
		assert.equal(result.isError, true);
		ticker.fire();
		assert.deepEqual(h.updates, [], "a batch with no child drew a view");
	} finally {
		for (const controller of h.watchers) controller.abort("shutdown");
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// What the view may not do
// ────────────────────────────────────────────────────────────────────────────

test("a live line is cut to the width it is drawn in, never wrapped onto another row", () => {
	const fake = fakePlain();
	const h = harness(fake.supervisor, undefined);
	try {
		const long = `${MARKER} ${"x".repeat(400)}`;
		const component = h.tool.renderResult?.(
			{ content: [{ type: "text", text: long }], details: { status: "running", live: [long] } } as never,
			{ expanded: false, isPartial: true } as never,
			theme as never,
			{} as never,
		);
		const lines = component?.render(40) ?? [];
		assert.equal(lines.length, 1, "the live line wrapped instead of being cut");
		assert.equal(visibleWidth(lines[0] ?? ""), 40);
		assert.match(lines[0] ?? "", /\.\.\./);
	} finally {
		for (const controller of h.watchers) controller.abort("shutdown");
		h.cleanup();
	}
});

test("a pane-host batch has no output seam, so it draws no live lines", async () => {
	const closed: string[] = [];
	const supervisor: Supervisor = {
		kind: "rex",
		detectedIn: () => true,
		createCapability: (): CapabilityCheck => ({
			ensureReady: async () => null,
			probe: async () => ({ problem: null, fix: null }),
			reset: () => {},
		}),
		open: async () => assert.fail("a finished child is never reopened"),
		ended: async () => false,
		stop: async () => {},
		close: async (child) => {
			closed.push(child.id);
			return true;
		},
	};

	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-pane-live-"));
	const sessionFile = join(dir, "worker.jsonl");
	writeFileSync(sessionFile, "", "utf8");
	writeFileSync(`${sessionFile}.done`, JSON.stringify({ type: "done", result: REPORT }));

	const child: SupervisorHandle = { supervisor, id: "w1:p2Z" };
	const running: RunningSubagent = {
		id: "worker-id",
		name: "worker",
		agent: "worker",
		profile: null,
		paneId: "w1:p2Z",
		child,
		writesSession: false,
		sessionFile,
		exitCodeFile: `${sessionFile}.exitcode`,
		reportFile: `${sessionFile}.done`,
		startedAt: Date.now(),
		task: "task worker",
	};

	const ticker = manualTicker();
	const views: string[][] = [];
	try {
		const results = await watchBatch([running], undefined, {
			watchers: new Set(),
			columns: new LiveSubPanes(),
			onLines: (lines) => views.push([...lines]),
			live: { every: ticker.every, now: () => 0 },
		});
		ticker.fire();

		assert.deepEqual(results.map((result) => result.outcome.kind), ["completed"]);
		assert.deepEqual(views, [], "a pane child drew a live view");
		assert.deepEqual(closed, ["w1:p2Z"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
