/**
 * Nudge smoke test: the bounded self-correction, proven in a real child pane.
 *
 * The unit tests stop at the send — they assert that a settled-but-unreported
 * child is asked to report, and that the ask is capped. They cannot show that
 * the ask *revives* the child, because that is a property of pi's agent loop,
 * not of this repo: a user message sent from `agent_settled` has to start a new
 * run in a child that has already ended its turn.
 *
 * This drives a real child in a real herdr pane, running real pi against a local
 * provider we control, and makes the child forget on purpose. The provider
 * answers the first turn with prose and no tool call, so the child ends its turn
 * unreported — the exact state that used to hold the batch forever. If the nudge
 * does not reach the model, there is no second request and the harness times out.
 *
 * What this proves, with real panes and a real pi child:
 *
 *   - an unreported `done` sends the reminder into the child's own session,
 *   - the reminder starts a new run against the model,
 *   - a report that follows a reminder lands as a normal report: the pane closes
 *     and the orchestrator receives `completed (reported)`.
 *
 * Run it with the reminder disabled (`REPORT_NUDGE_LIMIT = 0`) and it fails after
 * one model request — the child ends its turn unreported and nothing revives it.
 * That is the bug this harness exists to keep fixed, and it is the shape the child
 * pane shows while the harness waits: the task, one prose answer, and a prompt
 * still sitting there.
 *
 * Usage: node scripts/smoke-nudge.ts [agent]
 *
 * Manual, like the other smoke scripts: it needs a herdr session with the
 * tinysubagent plugin enabled, and nothing gates on it. No external provider and
 * no credentials — the whole model side is the local endpoint below.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { REPORT_REMINDER } from "../src/children/child.ts";
import { childSessionDirFor } from "../src/children/launch-paths.ts";
import { resolveProjectAgentDir } from "../src/children/requests.ts";
import { TOOL_NAME } from "../src/children/spawn.ts";
import { isInsideHerdr, herdrPaneExists, herdrPluginInfo, PLUGIN_ID } from "../src/herdr/cli.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { REPORT_TOOL_NAME } from "../src/types.ts";

function fail(message: string): never {
	console.error(`\nFAIL ${message}`);
	process.exit(1);
}

if (!isInsideHerdr()) fail("this harness needs a herdr session (HERDR_ENV is not set)");
const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`herdr plugin ${PLUGIN_ID} is missing or disabled`);

const args = process.argv.slice(2);
const { agents } = discoverAgents(process.cwd());
const agentName = args.find((arg) => !arg.startsWith("--")) ?? "worker";
const agent = agents.find((entry) => entry.name === agentName) ?? agents[0];
if (!agent) fail("no agents found");

/**
 * A fragment of the reminder, taken from the message itself so a rewording moves
 * both sides together. Short on purpose: a prefix survives whatever escaping the
 * request body and the session jsonl apply to the full sentence.
 */
const NUDGE_MARKER = REPORT_REMINDER.slice(0, REPORT_REMINDER.indexOf("`")).trim();
/** The result the fake model reports once the reminder arrives. */
const RESULT = "NUDGED";

// ── The fake provider ───────────────────────────────────────────────────────
// Speaks just enough OpenAI chat-completions streaming to be a model pi accepts.
// The interesting part is which turn it answers: the first request gets prose and
// no tool call (the child forgets), the request that carries the reminder gets the
// report call (the child recovers). The hand-back is answered *once* — the reminder
// stays in the transcript for every later turn, so a provider that keyed off its
// presence alone would answer report-call after report-call and drive a loop of
// its own making. Anything else gets harmless prose.
const requests: string[] = [];
let reported = false;

/** One SSE `data:` frame carrying `delta` for the single choice. */
function frame(delta: Record<string, unknown>, finish: string | null): string {
	const body = {
		id: "chatcmpl-smoke",
		object: "chat.completion.chunk",
		created: 0,
		model: "smoke",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

function textTurn(text: string): string {
	return frame({ role: "assistant", content: text }, null) + frame({}, "stop") + "data: [DONE]\n\n";
}

function reportTurn(result: string): string {
	const call = {
		index: 0,
		id: "call_smoke_report",
		type: "function",
		function: { name: REPORT_TOOL_NAME, arguments: JSON.stringify({ result }) },
	};
	return (
		frame({ role: "assistant", content: "" }, null) +
		frame({ tool_calls: [call] }, null) +
		frame({}, "tool_calls") +
		"data: [DONE]\n\n"
	);
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (data) => {
		raw += data;
	});
	req.on("end", () => {
		requests.push(raw);
		const recover = raw.includes(NUDGE_MARKER) && !reported;
		reported ||= recover;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.end(recover ? reportTurn(RESULT) : textTurn("The answer is 41. I am done."));
	});
});
const port: number = await new Promise((resolve) => {
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve(typeof address === "object" && address !== null ? address.port : 0);
	});
});
const endpoint = `http://127.0.0.1:${port}/v1`;

// ── A child agent dir that points the model at it ───────────────────────────
const scratch = join(tmpdir(), `tinysubagent-smoke-nudge-${Date.now()}`);
const childAgentDir = join(scratch, "agent");
mkdirSync(childAgentDir, { recursive: true });
writeFileSync(
	join(childAgentDir, "models.json"),
	JSON.stringify({
		providers: {
			"oc-openai": {
				baseUrl: endpoint,
				api: "openai-completions",
				apiKey: "smoke",
				models: [
					{
						id: "deepseek-flash",
						name: "Smoke nudge",
						contextWindow: 200_000,
						maxTokens: 8_192,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
	"utf8",
);
writeFileSync(
	join(childAgentDir, "settings.json"),
	JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
	"utf8",
);

// The generated wrapper prepends this to the child's pi command, so the child runs
// against the scratch agent dir without touching the user's own configuration.
const previousPrefix = process.env.PI_HERDR_LAUNCH_PREFIX;
process.env.PI_HERDR_LAUNCH_PREFIX = `env PI_CODING_AGENT_DIR=${childAgentDir}`;

// ── Session dir of our own ──────────────────────────────────────────────────
const sessionDir = join(getAgentDir(), "sessions", "--tinysubagent-smoke--");
const sessionId = "smoke-nudge";
const sessionFile = join(sessionDir, `${sessionId}-${Date.now()}.jsonl`);
mkdirSync(sessionDir, { recursive: true });
// The orchestrator's own outputs — the launch script and the task markdown — land
// under here, keyed by session id. Only this run's subtree is ours to remove.
const artifactDir = join(sessionDir, "artifacts", sessionId);

function cleanup(): void {
	rmSync(scratch, { recursive: true, force: true });
	rmSync(artifactDir, { recursive: true, force: true });
	rmSync(sessionFile, { force: true });
	server.close();
}

// ── Stub surface ────────────────────────────────────────────────────────────
const tools: Record<string, unknown>[] = [];
const sent: { message: { content: string }; options: unknown }[] = [];
let steerResolve: (() => void) | null = null;
const steered = new Promise<void>((resolve) => {
	steerResolve = resolve;
});

const api = {
	on() {},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string }, options: unknown) {
		sent.push({ message, options });
		steerResolve?.();
	},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: TOOL_NAME }],
};

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	thinkingLevel: "low",
	model: { provider: "oc-openai", id: "deepseek-flash" },
	sessionManager: {
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getCwd: () => process.cwd(),
		getEntries: () => [],
	},
	ui: { notify: () => {} },
	isProjectTrusted: () => true,
	abort: () => {},
	signal: new AbortController().signal,
	getSystemPrompt: () => "",
};

tinysubagent(api as never);
const tool = tools[0] as
	| {
			execute: (
				id: string,
				params: unknown,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
	  }
	| undefined;
if (!tool) fail("the extension registered no tool — is the plugin entrypoint loaded?");

const ack = await tool.execute(
	"call-1",
	{ agent: agent.name, task: "Reply with exactly the single word PONG." },
	undefined,
	undefined,
	ctx,
);
const spawned = (ack.details.spawned as { paneId: string }[] | undefined)?.[0];
if (!spawned?.paneId) {
	process.env.PI_HERDR_LAUNCH_PREFIX = previousPrefix;
	cleanup();
	fail(`nothing was spawned: ${JSON.stringify(ack.details)}`);
}
const { paneId } = spawned;

// Where the child's session and its sidecars live: the same rule the tool uses,
// because the child is launched with an explicit `--session` path under it.
const plannedDir = childSessionDirFor(resolveProjectAgentDir(process.cwd()) ?? getAgentDir(), process.cwd());
const spawnedAt = Date.now();
console.log(`spawned pane ${paneId} against ${endpoint}`);
console.log(ack.content[0]?.text ?? "(no ack text)");

// Never leave a live child behind, however this harness dies. `execFileSync` and
// not the async `herdrPaneClose` helper: this runs from `process.on("exit")`,
// where only synchronous work finishes.
let reaped = false;
function reap(): void {
	if (reaped) return;
	reaped = true;
	try {
		execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
	} catch {
		// Already gone.
	}
}

/** The child's own files for this run, once we know which they are. */
let childSessionFile: string | null = null;

/**
 * This run's child session files. The child is launched with an explicit
 * `--session` path under `plannedDir`, and pi creates it as it starts, so this
 * finds it before the run has produced anything to assert on.
 */
function childSessionsSoFar(): string[] {
	return readdirSync(plannedDir)
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(plannedDir, entry))
		.filter((file) => statSync(file).mtimeMs >= spawnedAt);
}

// Learn the session path as soon as pi writes it, so that even a signal arriving
// before the child reports still knows which files this run created. Bounded: a
// child pi that never starts is diagnosed by the timeout, not by waiting here.
for (let waited = 0; childSessionFile === null && waited < 10_000; waited += 100) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	childSessionFile = childSessionsSoFar()[0] ?? null;
}

/** Reap, restore the environment, and delete everything this run created. */
function shutdown(): void {
	reap();
	if (childSessionFile !== null) {
		// The report sidecar itself is normally gone by now: the orchestrator's
		// watcher deletes it as soon as it accepts the outcome (`watcher.ts`), so
		// `completed (reported)` is the surviving evidence that it was consumed.
		for (const suffix of ["", ".done", ".exitcode"]) {
			rmSync(`${childSessionFile}${suffix}`, { force: true });
		}
	}
	process.env.PI_HERDR_LAUNCH_PREFIX = previousPrefix;
	cleanup();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		shutdown();
		process.exit(130);
	});
}
process.on("exit", shutdown);

const timeoutMs = 180_000;
const timeout = setTimeout(
	() => {
		// Capture before reaping: the pane is the only place the child's own account
		// of what happened survives, and reaping closes it.
		const pane = (() => {
			try {
				return execFileSync("herdr", ["pane", "read", paneId], { encoding: "utf8" });
			} catch {
				return "(pane capture unavailable)";
			}
		})();
		shutdown();
		fail(
			`timed out after ${timeoutMs / 1000}s with ${requests.length} model request(s).\n` +
				"If the count is 1, the child ended its turn unreported and nothing revived it —\n" +
				"the reminder never became a turn, which is the whole point of the nudge.\n" +
				`\n── child pane ──\n${pane}`,
		);
	},
	timeoutMs,
);
await steered;
clearTimeout(timeout);

console.log(`\n── steer message ──\n${sent.map((entry) => entry.message.content).join("\n\n")}`);
const body = sent.map((entry) => entry.message.content).join("\n");

// The child's own session, from the files this run planned. Checked before any
// assertion, so that a failure below still knows what to delete on the way out.
const childSessions = childSessionsSoFar();
if (childSessions.length !== 1) {
	fail(`expected one child session in ${plannedDir}, found ${childSessions.length}: ${childSessions.join(", ")}`);
}
childSessionFile = childSessions[0] as string;

// The reminder reached the model: a request after the first carries it. Without
// the nudge there is no second request at all, so this is the E2E claim.
assert.ok(
	requests.length >= 2,
	`the child made ${requests.length} model request(s): it ended its turn unreported and nothing revived it`,
);
assert.ok(
	!requests[0]?.includes(NUDGE_MARKER),
	"the first model request already carried the reminder — the harness missed the forgetful state it exists to test",
);
assert.ok(
	requests.slice(1).some((request) => request.includes(NUDGE_MARKER)),
	"no model request after the first carried the reminder: the child was never asked to report",
);
// `via: "report"` is the only outcome that renders as "reported", so this one
// assertion carries the hand-back: the sidecar arrived through the report tool.
assert.equal(sent.length, 1, `expected one steer message, got ${sent.length}`);
assert.ok(body.includes("completed (reported)"), `expected \`completed (reported)\`:\n${body}`);
assert.ok(body.includes(RESULT), `expected the reported result \`${RESULT}\`:\n${body}`);

// The reminder is a user turn in the child's own session, exactly once. This is
// the count the cap governs: a second reminder would put a second copy here.
const childSession = readFileSync(childSessionFile, "utf8");
assert.equal(
	childSession.split(NUDGE_MARKER).length - 1,
	1,
	`the child's session does not carry exactly one reminder:\n${childSession.slice(-2000)}`,
);

// And the child really did end. The pane closes when the child's pi exits, which
// happens *after* the watcher saw the sidecar and steered us, so poll rather than
// probe once — and treat a failed probe (`null`) as "not still open", because a
// transient herdr hiccup is not the bug under test.
const alive = await (async function awaitPaneClosed(): Promise<boolean | null> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const state = await herdrPaneExists(paneId);
		if (state !== true || Date.now() >= deadline) return state;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
})();
assert.notEqual(alive, true, "the child pane is still open after a report");

shutdown();
console.log("\nPASS an unreported child was reminded in its own pane, recovered, and reported");
process.exit(0);
