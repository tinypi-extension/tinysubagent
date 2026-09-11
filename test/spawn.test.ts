import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	MAX_PARALLEL_TASKS,
	TOOL_NAME,
	collectRequests,
	resolveCwd,
	spawnOne,
	uniqueName,
	type SpawnContext,
	type ToolParams,
} from "../src/spawn.ts";
import { REPORT_TOOL_NAME, type AgentDef } from "../src/types.ts";

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
