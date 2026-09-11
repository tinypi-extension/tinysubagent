import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PLUGIN_ENTRYPOINT, PLUGIN_ID, type Rect, type TabLayout } from "../../src/herdr/cli.ts";
import { LiveSubPanes, planResizes } from "../../src/herdr/layout.ts";
import { MAX_PARALLEL_TASKS, collectRequests, resolveCwd, uniqueName } from "../../src/children/requests.ts";
import { TOOL_NAME, spawnOne } from "../../src/children/spawn.ts";
import type { SpawnContext, ToolParams } from "../../src/children/contract.ts";
import { REPORT_TOOL_NAME, type AgentDef } from "../../src/types.ts";

test("single mode takes an agent and a task", () => {
	const mode = collectRequests({ agent: "worker", task: "Do it." });
	assert.equal(mode.ok, true);
	assert.deepEqual(mode.ok && mode.requests, [
		{ agent: "worker", task: "Do it.", name: "worker", profile: undefined },
	]);
});

test("an explicit name overrides the agent name, and whitespace is trimmed", () => {
	const mode = collectRequests({ agent: " worker ", task: "  Do it.  ", name: "  scout  " });
	assert.deepEqual(mode.ok && mode.requests[0], {
		agent: "worker",
		task: "Do it.",
		name: "scout",
		profile: undefined,
	});
});

test("a missing agent or task is refused with a message naming both modes", () => {
	const missing = collectRequests({ agent: "worker" });
	assert.equal(missing.ok, false);
	assert.match(missing.ok === false ? missing.error : "", /provide `agent` and `task`.*or `tasks`/);

	const blank = collectRequests({ agent: "worker", task: "   " });
	assert.equal(blank.ok, false);
	assert.match(blank.ok === false ? blank.error : "", /non-empty/);
});

test("several tasks each become their own request", () => {
	const mode = collectRequests({
		tasks: [
			{ agent: "worker", task: "one" },
			{ agent: "scout", task: "two", name: "finder", profile: "pro" },
		],
	});
	assert.equal(mode.ok, true);
	assert.deepEqual(mode.ok && mode.requests, [
		{ agent: "worker", task: "one", name: "worker", profile: undefined },
		{ agent: "scout", task: "two", name: "finder", profile: "pro" },
	]);
});

test("two children in a batch can never share a label", () => {
	// Names key the artifact files and the pane label, so a collision would make
	// one child's result overwrite the other's.
	const mode = collectRequests({
		tasks: [
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
			{ agent: "worker", task: "three", name: "worker" },
		],
	});
	assert.deepEqual(
		mode.ok && mode.requests.map((request) => request.name),
		["worker", "worker-2", "worker-3"],
	);
});

test("mixing both modes is refused rather than silently preferred", () => {
	const mode = collectRequests({
		agent: "worker",
		task: "one",
		tasks: [{ agent: "worker", task: "two" }],
	});
	assert.equal(mode.ok, false);
	assert.match(mode.ok === false ? mode.error : "", /not both/);
});

test("an empty tasks array falls back to the single-task error", () => {
	const mode = collectRequests({ tasks: [] });
	assert.equal(mode.ok, false);
	assert.match(mode.ok === false ? mode.error : "", /provide `agent` and `task`/);
});

test("a batch larger than the cap is refused, and the cap is the only reason", () => {
	const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_value, index) => ({
		agent: "worker",
		task: `task ${index}`,
	}));
	assert.equal(collectRequests({ tasks }).ok, true);

	const tooMany = [...tasks, { agent: "worker", task: "one too many" }];
	const refused = collectRequests({ tasks: tooMany });
	assert.equal(refused.ok, false);
	assert.match(
		refused.ok === false ? refused.error : "",
		new RegExp(`too many tasks: ${MAX_PARALLEL_TASKS + 1} \\(limit ${MAX_PARALLEL_TASKS}\\)`),
	);
});

test("a malformed entry names its own index", () => {
	// Deliberately malformed, as a model could send it: validated at runtime.
	const input = {
		tasks: [{ agent: "worker", task: "ok" }, { agent: "scout" }],
	} as unknown as ToolParams;
	const missing = collectRequests(input);
	assert.equal(missing.ok, false);
	assert.match(missing.ok === false ? missing.error : "", /tasks\[1\] needs both "agent" and "task"/);
});

test("unique names keep counting past the first collision", () => {
	const used = new Set<string>();
	assert.equal(uniqueName("worker", used), "worker");
	assert.equal(uniqueName("worker", used), "worker-2");
	assert.equal(uniqueName("worker", used), "worker-3");
	assert.equal(uniqueName("scout", used), "scout");
});

test("cwd resolution is pure path work; a bad path is left to fail loudly", () => {
	// Existence is deliberately not checked here: an unusable cwd reaches herdr and
	// comes back as a failure naming the child, which beats silently running the
	// child somewhere the caller did not ask for.
	assert.equal(resolveCwd("/abs/path", "/fallback"), "/abs/path");
	assert.equal(resolveCwd("sub/dir", "/fallback"), "/fallback/sub/dir");
	assert.equal(resolveCwd(undefined, "/fallback"), "/fallback");
	assert.equal(resolveCwd("   ", "/fallback"), "/fallback");
	assert.equal(resolveCwd("  /abs  ", "/fallback"), "/abs");
});

// ────────────────────────────────────────────────────────────────────────────
// spawnOne validation, which must happen before any pane is opened
// ────────────────────────────────────────────────────────────────────────────

function context(agents: readonly AgentDef[], allToolNames: string[] = ["read", "bash"]): SpawnContext {
	return {
		cwd: "/tmp",
		agentDir: "/tmp/agent",
		agentDirOverride: null,
		sessionDir: "/tmp/sessions",
		sessionId: "sid",
		env: {},
		allToolNames,
		agents,
		config: { enableProfiles: false, profiles: {}, sources: [] },
	};
}

const worker: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	tools: ["read"],
	source: "user",
	path: "/tmp/worker.md",
};

test("an unknown role is refused before anything is launched", async () => {
	const result = await spawnOne({ agent: "nope", task: "x", name: "nope" }, context([worker]));
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /unknown agent "nope"\. Available: `worker`\./);
});

test("an unknown role with no roles at all says so instead of listing nothing", async () => {
	const result = await spawnOne({ agent: "nope", task: "x", name: "nope" }, context([]));
	assert.match(result.ok === false ? result.error : "", /Available: \(none\)\./);
});

test("a disabled profile set refuses a named profile before launching", async () => {
	const result = await spawnOne({ agent: "worker", task: "x", name: "worker", profile: "pro" }, context([worker]));
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /pro/);
});

test("a role that could spawn subagents is refused rather than half-supported", async () => {
	// The pane would close on this child's own settle, stranding its children's
	// results. Refusing loudly is the whole point: no pane is opened here.
	const nested: AgentDef = { ...worker, name: "boss", tools: ["read", TOOL_NAME] };
	const result = await spawnOne(
		{ agent: "boss", task: "x", name: "boss" },
		context([nested], ["read", TOOL_NAME]),
	);
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /Nested delegation is not supported/);
	assert.match(result.ok === false ? result.error : "", new RegExp(`Remove \`${TOOL_NAME}\``));
});

// ────────────────────────────────────────────────────────────────────────────
// Allowlist injection, observed through the launch script spawnOne wrote
// ────────────────────────────────────────────────────────────────────────────

/** The launch script `spawnOne` wrote, read back off disk. */
function writtenScript(sessionDir: string, sessionId: string): string {
	const dir = join(sessionDir, "artifacts", sessionId, "subagent-scripts");
	const [file] = readdirSync(dir);
	assert.ok(file, "no launch script was written");
	return readFileSync(join(dir, file), "utf8");
}

/**
 * Run `spawnOne` against a scratch directory and hand back the wrapper it wrote.
 *
 * The pane cannot be opened here — `HERDR_BIN_PATH` is pointed at a binary that
 * cannot exist, so the spawn fails at the last step. That is far enough: the
 * launch files, allowlist included, are written before herdr is ever called.
 */
async function spawnInScratch(agent: AgentDef): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-spawn-"));
	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = join(dir, "no-herdr-here");
	try {
		const result = await spawnOne(
			{ agent: agent.name, task: "x", name: agent.name },
			{ ...context([agent]), cwd: dir, agentDir: dir, sessionDir: dir, env: {} },
		);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /could not open a pane/);
		const script = writtenScript(dir, "sid");
		rmSync(join(dir, "sessions"), { recursive: true, force: true });
		return script;
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a role with a tools list can still call the report tool", async () => {
	// `read` is what the role asked for; the report tool is what every child needs
	// to be able to finish, and a role cannot know to ask for it.
	const script = await spawnInScratch(worker);
	// Fully escaped argv: the flag is quoted like every other argument.
	assert.match(script, new RegExp(`'--tools' 'read,${REPORT_TOOL_NAME}'`));
});

test("a role with no tools frontmatter is not narrowed by an invented allowlist", async () => {
	// Injecting into a null list would turn "every tool is available" into
	// "only the report tool is available" — the worst possible silent narrowing.
	const open: AgentDef = { ...worker, name: "open", tools: undefined };
	const script = await spawnInScratch(open);
	assert.equal(script.includes("--tools"), false);
});

test("a wildcard that matches nothing does not produce a one-tool allowlist", async () => {
	// The role declared only a pattern, and nothing matched it. `expandToolPatterns`
	// then hands back an empty list, which must NOT become "report tool only" —
	// that would strip read/write/bash/edit from a child that declared no such limit.
	const unmatched: AgentDef = { ...worker, name: "unmatched", tools: ["codegraph_*"] };
	const script = await spawnInScratch(unmatched);
	assert.equal(script.includes("--tools"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Placement and resize sequencing, observed through the herdr argv
// ────────────────────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run `fn` with HERDR_BIN_PATH pointed at a stub that answers one queued
 * response per invocation — payload and exit code for call N are queue entry N.
 * Each invocation's argv is captured on its own.
 *
 * This mirrors the helper in `test/herdr.test.ts`, duplicated because that one
 * is not exported. A call past the end of the queue repeats the last response:
 * `spawnOne` fires the cosmetic rename without awaiting it, so the extra
 * invocation must not become a mystifying missing-payload error.
 */
async function withHerdrStubScript<T>(
	responses: { payload: string; exitCode?: number }[],
	fn: () => Promise<T>,
): Promise<{ result: T; calls: string[][] }> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-spawn-herdr-"));
	const counterFile = join(dir, "count");
	const stub = join(dir, "herdr");
	const payloads = responses.map((entry) => shellQuote(entry.payload)).join(" ");
	const codes = responses.map((entry) => String(entry.exitCode ?? 0)).join(" ");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			`dir=${shellQuote(dir)}`,
			`payloads=(${payloads})`,
			`codes=(${codes})`,
			`count=$(cat "$dir/count" 2>/dev/null || echo 0)`,
			`printf '%s\\n' "$@" > "$dir/argv-$count.txt"`,
			`printf '%s' "$((count + 1))" > "$dir/count"`,
			`n=\${#payloads[@]}`,
			'if [ "$n" -eq 0 ]; then exit 0; fi',
			"idx=$count",
			'if [ "$idx" -ge "$n" ]; then idx=$((n - 1)); fi',
			`printf '%s' "\${payloads[$idx]}"`,
			`exit "\${codes[$idx]}"`,
		].join("\n") + "\n",
	);
	chmodSync(stub, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		const result = await fn();
		const count = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8").trim()) || 0 : 0;
		const calls: string[][] = [];
		for (let i = 0; i < count; i += 1) {
			const file = join(dir, `argv-${i}.txt`);
			if (!existsSync(file)) continue;
			const text = readFileSync(file, "utf8");
			calls.push(text === "" ? [] : text.replace(/\n$/, "").split("\n"));
		}
		return { result, calls };
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

const ORCH = "pane-orch";
const NEW = "pane-new";
const LIVE_A = "pane-live-a";
const LIVE_B = "pane-live-b";

const resizePayload = '{"id":"cli:pane","result":{"ok":true}}';
const openPayload = JSON.stringify({
	id: "cli:plugin",
	result: { plugin_pane: { pane: { pane_id: NEW } } },
});

interface PaneSpec {
	paneId: string;
	rect: Rect;
}

/** A `pane layout` payload for the stub. */
function layoutPayload(panes: PaneSpec[]): string {
	return JSON.stringify({
		id: "cli:pane",
		result: {
			layout: {
				tab_id: "tab-1",
				panes: panes.map((pane) => ({ pane_id: pane.paneId, rect: pane.rect })),
			},
		},
	});
}

/** The same fixture as the `TabLayout` the planner receives. */
function plannerLayout(panes: PaneSpec[]): TabLayout {
	return { tabId: "tab-1", panes: panes.map((pane) => ({ paneId: pane.paneId, rect: { ...pane.rect } })) };
}

/**
 * Spawn one worker against a scripted herdr stub and hand back every recorded
 * argv. `spawnOne`'s scratch directory is removed before returning, but the
 * cwd/script paths embedded in those argv strings stay valid for assertions.
 */
async function spawnWithStub(
	responses: { payload: string; exitCode?: number }[],
	columns?: LiveSubPanes,
): Promise<{ result: Awaited<ReturnType<typeof spawnOne>>; calls: string[][]; cwd: string; scriptFile: string }> {
	const cwd = mkdtempSync(join(tmpdir(), "tinysubagent-spawn-layout-"));
	try {
		const { result, calls } = await withHerdrStubScript(responses, async () => {
			const spawned = await spawnOne(
				{ agent: "worker", task: "x", name: "worker" },
				{
					...context([worker]),
					cwd,
					agentDir: cwd,
					sessionDir: cwd,
					env: { HERDR_PANE_ID: ORCH },
					columns,
				},
			);
			// The rename is fire-and-forget in `spawnOne`; let it land so the recorded
			// call sequence is the whole sequence rather than a race.
			await new Promise((resolve) => setTimeout(resolve, 150));
			return spawned;
		});
		const scriptsDir = join(cwd, "artifacts", "sid", "subagent-scripts");
		const scriptFile = existsSync(scriptsDir) ? join(scriptsDir, readdirSync(scriptsDir)[0] ?? "") : "";
		return { result, calls, cwd, scriptFile };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
}

function openCall(calls: string[][]): string[] {
	const found = calls.find((argv) => argv[0] === "plugin" && argv[1] === "pane" && argv[2] === "open");
	assert.ok(found, "spawnOne issued no pane open call");
	return found;
}

function layoutCallIndices(calls: string[][]): number[] {
	return calls.flatMap((argv, index) => (argv[0] === "pane" && argv[1] === "layout" ? [index] : []));
}

test("spawnOne: an empty column opens right off the orchestrator and resizes once", async () => {
	const before: PaneSpec[] = [{ paneId: ORCH, rect: { x: 0, y: 0, width: 211, height: 58 } }];
	const after: PaneSpec[] = [
		{ paneId: ORCH, rect: { x: 0, y: 0, width: 84, height: 58 } },
		{ paneId: NEW, rect: { x: 84, y: 0, width: 127, height: 58 } },
	];
	const { result, calls } = await spawnWithStub(
		[
			{ payload: layoutPayload(before) },
			{ payload: openPayload },
			{ payload: layoutPayload(after) },
			{ payload: resizePayload },
		],
		new LiveSubPanes(),
	);

	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.running.paneId, NEW);

	const open = openCall(calls);
	assert.equal(flagValue(open, "--direction"), "right");
	assert.equal(flagValue(open, "--target-pane"), ORCH);

	// Exactly one op, on the new pane. The amount comes from `planResizes` so the
	// assertion pins the applied op, not the planner's arithmetic (that lives in
	// `test/layout.test.ts`).
	const expected = planResizes(plannerLayout(after), ORCH, [NEW], NEW);
	assert.equal(expected.length, 1);
	assert.deepEqual(calls[3], [
		"pane",
		"resize",
		"--direction",
		"right",
		"--amount",
		String(expected[0]?.amount),
		"--pane",
		NEW,
	]);

	// The placement read precedes the open; the resize read follows it.
	const layouts = layoutCallIndices(calls);
	const openIndex = calls.indexOf(open);
	assert.equal(layouts.length, 2);
	assert.ok(layouts[0]! < openIndex, "the placement read must happen before the open");
	assert.ok(layouts[1]! > openIndex, "the resize read must happen after the open");
	// The full sequence ends with the cosmetic rename, proving nothing new runs
	// after it.
	assert.deepEqual(calls[4], ["pane", "rename", NEW, "worker"]);
});

test("spawnOne: a live pane in the tab is appended to, not the orchestrator", async () => {
	const before: PaneSpec[] = [
		{ paneId: ORCH, rect: { x: 0, y: 0, width: 84, height: 58 } },
		{ paneId: LIVE_A, rect: { x: 84, y: 0, width: 127, height: 29 } },
	];
	const after: PaneSpec[] = [
		{ paneId: ORCH, rect: { x: 0, y: 0, width: 84, height: 58 } },
		{ paneId: LIVE_A, rect: { x: 84, y: 0, width: 127, height: 29 } },
		{ paneId: NEW, rect: { x: 84, y: 29, width: 127, height: 29 } },
	];
	const tracker = new LiveSubPanes();
	tracker.place(LIVE_A);
	const { result, calls } = await spawnWithStub(
		[{ payload: layoutPayload(before) }, { payload: openPayload }, { payload: layoutPayload(after) }],
		tracker,
	);

	assert.equal(result.ok, true);
	const open = openCall(calls);
	assert.equal(flagValue(open, "--direction"), "down");
	assert.equal(flagValue(open, "--target-pane"), LIVE_A);
	// The two column panes are already equal, so the pass emits nothing.
	assert.equal(calls.some((argv) => argv[1] === "resize"), false);
});

test("spawnOne: the resize pass matches planResizes and runs after the second read", async () => {
	const before: PaneSpec[] = [
		{ paneId: ORCH, rect: { x: 0, y: 0, width: 84, height: 58 } },
		{ paneId: LIVE_A, rect: { x: 84, y: 0, width: 127, height: 29 } },
		{ paneId: LIVE_B, rect: { x: 84, y: 29, width: 127, height: 15 } },
	];
	const after: PaneSpec[] = [
		{ paneId: ORCH, rect: { x: 0, y: 0, width: 84, height: 58 } },
		{ paneId: LIVE_A, rect: { x: 84, y: 0, width: 127, height: 29 } },
		{ paneId: LIVE_B, rect: { x: 84, y: 29, width: 127, height: 15 } },
		{ paneId: NEW, rect: { x: 84, y: 44, width: 127, height: 14 } },
	];
	const tracker = new LiveSubPanes();
	tracker.place(LIVE_A);
	tracker.place(LIVE_B);
	const { result, calls } = await spawnWithStub(
		[
			{ payload: layoutPayload(before) },
			{ payload: openPayload },
			{ payload: layoutPayload(after) },
			{ payload: resizePayload },
			{ payload: resizePayload },
		],
		tracker,
	);

	assert.equal(result.ok, true);

	// Two uneven panes make two ops (the 29 is too tall, then the 15 is too short,
	// measured against the shrunken node height rather than the full column).
	const expected = planResizes(plannerLayout(after), ORCH, [LIVE_A, LIVE_B, NEW], NEW);
	assert.deepEqual(
		expected.map((op) => op.paneId),
		[LIVE_B, NEW],
	);
	const expectedCalls = expected.map((op) => [
		"pane",
		"resize",
		"--direction",
		op.direction,
		"--amount",
		String(op.amount),
		"--pane",
		op.paneId,
	]);

	const open = openCall(calls);
	const openIndex = calls.indexOf(open);
	const layouts = layoutCallIndices(calls);
	assert.equal(layouts.length, 2);
	assert.ok(layouts[0]! < openIndex, "the placement read must happen before the open");
	assert.ok(layouts[1]! > openIndex, "the resize read must happen after the open");
	// Full sequence: placement read, open, resize read, each ops in order, rename.
	assert.equal(calls.length, openIndex + 2 + expectedCalls.length + 1);
	assert.deepEqual(calls[0], ["pane", "layout", "--pane", ORCH]);
	assert.deepEqual(calls[openIndex + 1], ["pane", "layout", "--pane", ORCH]);
	assert.deepEqual(calls.slice(openIndex + 2, openIndex + 2 + expectedCalls.length), expectedCalls);
	assert.deepEqual(calls[openIndex + 2 + expectedCalls.length], ["pane", "rename", NEW, "worker"]);
});

test("spawnOne: a spawn still succeeds when every layout read fails", async () => {
	const tracker = new LiveSubPanes();
	tracker.place(LIVE_A);
	const { result, calls } = await spawnWithStub(
		[{ payload: "", exitCode: 1 }, { payload: openPayload }, { payload: "", exitCode: 1 }],
		tracker,
	);

	// The real pane id comes back and the child is running; only the geometry is
	// missing. A failed read also means no resize pass.
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.running.paneId, NEW);
	assert.deepEqual(calls[0], ["pane", "layout", "--pane", ORCH]);
	assert.deepEqual(calls[2], ["pane", "layout", "--pane", ORCH]);
	assert.equal(calls.some((argv) => argv[1] === "resize"), false);
});

test("spawnOne: without a tracker the open argv is unchanged", async () => {
	const { result, calls, cwd, scriptFile } = await spawnWithStub([{ payload: openPayload }]);

	assert.equal(result.ok, true);
	// Byte-for-byte the pre-layout call: split right off the orchestrator, no
	// placement read, no resize.
	assert.deepEqual(calls[0], [
		"plugin",
		"pane",
		"open",
		"--plugin",
		PLUGIN_ID,
		"--entrypoint",
		PLUGIN_ENTRYPOINT,
		"--placement",
		"split",
		"--target-pane",
		ORCH,
		"--direction",
		"right",
		"--cwd",
		cwd,
		"--env",
		`PI_HERDR_LAUNCH_SCRIPT=${scriptFile}`,
		"--no-focus",
	]);
	assert.equal(layoutCallIndices(calls).length, 0);
	assert.deepEqual(calls[1], ["pane", "rename", NEW, "worker"]);
});
