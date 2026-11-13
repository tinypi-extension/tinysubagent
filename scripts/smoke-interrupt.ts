/**
 * Interrupt smoke test: the three interrupts the unit tests cannot reach, because
 * all three depend on how real pi reacts to a keystroke in a live pane.
 *
 * Phase A — Esc in the child's pane. That stops the child's turn without ending
 * the child: it stays at its prompt, the blocking call keeps waiting, the
 * orchestrator is told nothing, and the same child still reports after a
 * redirect. That report ends the call as `completed (reported)` and closes the
 * pane, because the child is gone.
 *
 * Phase B — aborting the call's own signal, which is what pi does when the turn
 * is interrupted. The wait ends as `interrupted`, and the relay that ends it types
 * one Esc into the child's pane before closing it: the phase waits for the pane to
 * be gone, which is the proof the child stopped, and checks the row comes back as
 * `interrupted (pane closed)` with no summary.
 *
 * Phase C — Esc in the orchestrator's pane, with two children in the batch. This
 * is the relay itself: the human's own keystroke is typed into the orchestrator's
 * pane, then the call's signal is aborted as pi would, and the call comes back
 * with interrupted rows, no summaries, no error, and both panes closed.
 *
 * The closed pane is also the end of the operator's access: an interrupted child
 * can no longer be redirected by hand, because there is no pane left to type into.
 * Nothing is left running once an interrupt returns the call.
 *
 * Run this from a plain shell in a herdr pane, not from pi's bash tool: phase C
 * types Esc into the orchestrator's own pane — the keystroke a human presses to
 * interrupt a turn — so a pi running there would have its own turn aborted
 * underneath the script. Phases B and C also close the panes their interrupt
 * stopped, so the pane this script runs in must not be one of them.
 *
 * Usage: node scripts/smoke-interrupt.ts [agent]
 */

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { currentPaneId, herdrPaneExists, herdrPaneLayout, herdrPluginInfo, PLUGIN_ID } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/types.ts";
import { readPane } from "./pane-state.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
	console.error(`\nFAIL ${message}`);
	process.exit(1);
}

const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`herdr plugin ${PLUGIN_ID} is missing or disabled`);

// The child's pane is found by diffing the tab's layout against this pane, since
// a blocking call returns no details until the whole batch is over.
const orchestratorPaneId = currentPaneId(process.env);
if (!orchestratorPaneId) fail("not running inside a herdr pane (HERDR_PANE_ID is unset)");

/**
 * The model the child inherits. Overridable so this smoke can run on a host whose
 * CLI does not know `oc-openai`, which is otherwise a refusal and not an interrupt.
 */
const [modelProvider = "oc-openai", ...modelRest] = (
	process.env.TINYSUBAGENT_SMOKE_MODEL ?? "oc-openai/deepseek-flash"
).split("/");
const model = { provider: modelProvider, id: modelRest.join("/") || "deepseek-flash" };

const { agents } = discoverAgents(process.cwd());
const agentName = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "worker";
const agent = agents.find((entry) => entry.name === agentName) ?? agents[0];
if (!agent) fail("no agents found");

const sessionDir = join_(getAgentDir(), "sessions", "--tinysubagent-smoke--");
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join_(sessionDir, `repro-${Date.now()}.jsonl`);

function join_(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/");
}

// ── Stub surface ────────────────────────────────────────────────────────────
const tools: Record<string, unknown>[] = [];
const listeners = new Map<string, unknown>();
/** Every message the tool sent to the orchestrator. A blocking call sends none. */
const sent: string[] = [];

const api = {
	on(event: string, handler: unknown) {
		listeners.set(event, handler);
	},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string }) {
		sent.push(message.content);
		console.log(`\n!!! ORCHESTRATOR MESSAGE ARRIVED (${sent.length}) !!!\n${message.content}`);
	},
	getAllTools: () => ["read", "bash", TOOL_NAME].map((name) => ({ name })),
};

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	thinkingLevel: "low",
	model,
	sessionManager: {
		getSessionFile: () => sessionFile,
		getSessionId: () => "repro-interrupt",
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
const tool = tools[0] as {
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: { text: string }[];
		/** A settled batch is content whatever it says; only a refusal is a tool error. */
		isError?: boolean;
		details: {
			status?: string;
			spawned?: { paneId: string }[];
			results?: {
				name: string;
				paneId: string;
				outcome: string;
				status?: string;
				via?: string;
				/** Which interrupt ended the wait: the operator's own, or a shutdown. */
				cause?: "interrupt" | "shutdown";
				/** `null` whenever the child left nothing to hand back, which an interrupt always is. */
				summary?: string | null;
			}[];
		};
	}>;
};

// ── Pane discovery and cleanup ──────────────────────────────────────────────
const opened: string[] = [];

/** The child pane: the one in this tab that is not the orchestrator's. */
async function findChildPane(exclude: readonly string[]): Promise<string | null> {
	const layout = await herdrPaneLayout(orchestratorPaneId!);
	const panes = layout?.panes.map((pane) => pane.paneId) ?? [];
	return panes.find((id) => id !== orchestratorPaneId && !exclude.includes(id) && !opened.includes(id)) ?? null;
}

async function waitChildPane(exclude: readonly string[] = []): Promise<string> {
	for (let i = 0; i < 60; i += 1) {
		const found = await findChildPane(exclude);
		if (found) {
			opened.push(found);
			return found;
		}
		await sleep(500);
	}
	return fail("no child pane appeared beside the orchestrator");
}

async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(500);
	}
	return false;
}

/**
 * Wait until the pane is gone, and fail loudly with its id if it stays open. A
 * closed pane is the proof the child stopped: the relay closes every pane it
 * interrupts, so a pane still there after the call returned is an interrupt that
 * left a child running with nobody waiting on it.
 */
async function waitClosed(paneId: string): Promise<void> {
	const closed = await waitUntil(async () => (await herdrPaneExists(paneId)) === false, 20_000);
	if (!closed) fail(`pane ${paneId} is still open after the interrupt — the interrupted child was left behind`);
}

// This harness must never leave a live child behind, however it dies — including
// being interrupted itself, which is how the previous orphaned pane happened.
let reaped = false;
function reap(): void {
	if (reaped) return;
	reaped = true;
	for (const paneId of opened) {
		try {
			execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
		} catch {
			// Already gone: the interesting case, so nothing to report.
		}
	}
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {
	reap();
	process.exit(130);
});
process.on("exit", reap);

/** Wait until the child is visibly mid-work, so the Esc lands on a running turn. */
async function waitBusy(paneId: string): Promise<void> {
	for (let i = 0; i < 60; i += 1) {
		await sleep(1_000);
		if ((await readPane(paneId)).includes("sleep")) {
			console.log(`child in pane ${paneId} is mid-work after ${i + 1}s (bash sleep visible in its pane)`);
			return;
		}
	}
	fail(`the child in pane ${paneId} never started its bash call — cannot interrupt anything`);
}

// ── Phase A: Esc in the child's pane ────────────────────────────────────────
console.log("\n── phase A: esc in the child's pane ──");
let settledA: Awaited<ReturnType<typeof tool.execute>> | null = null;
const callA = tool
	.execute(
		"call-a",
		{
			tasks: [{
				agent: agent.name,
				task: "Run the bash command `sleep 120`, wait for it to finish, then reply with exactly the single word SLOW.",
			}],
		},
		undefined,
		undefined,
		ctx,
	)
	.then((result) => {
		settledA = result;
		return result;
	});

const paneA = await waitChildPane();
console.log(`child pane ${paneA}`);
await waitBusy(paneA);
await sleep(2_000);

console.log("\n── sending esc to the child pane ──");
await run("herdr", ["pane", "send-keys", paneA, "esc"]);

const holdMs = 8_000;
console.log(`waiting ${holdMs / 1000}s to see whether the call ends...`);
await sleep(holdMs);

if (settledA !== null) {
	const broken = settledA as Awaited<ReturnType<typeof tool.execute>>;
	fail(`the blocking call returned after an interrupt: ${broken.content[0]?.text ?? ""}`);
}
console.log("the call is still waiting, and nothing was delivered to the orchestrator");

const aliveA = await herdrPaneExists(paneA);
console.log(`child pane still open: ${aliveA}`);
if (aliveA !== true) fail("the child pane closed on interrupt — the user cannot redirect it");
if ((await readPane(paneA)).includes("sleep")) console.log("(pane still shows the aborted call)");

// ── The redirect: type into the child and let it finish ─────────────────────
console.log("\n── redirecting the child ──");
await run("herdr", ["pane", "run", paneA, "Reply with exactly the single word PONG. Do not explain."]);

const resultA = await callA;
const textA = resultA.content[0]?.text ?? "";
assert.ok(textA.includes("PONG"), `the redirect's result is missing:\n${textA}`);
assert.ok(textA.includes("completed (reported)"), `the redirect was not reported as completed:\n${textA}`);
assert.equal(resultA.details.results?.[0]?.via, "report", "the report was read as a settle, not the child's hand-back");
console.log("\n✓ the redirected child reported normally, and the call returned it");

// A reported child is gone, so its pane is closed for it.
const closedA = await waitUntil(async () => (await herdrPaneExists(paneA)) === false, 15_000);
console.log(`reported child's pane closed: ${closedA}`);
if (!closedA) fail("the reported child's pane stayed open");

// ── Phase B: aborting the call's signal ────────────────────────────────────
console.log("\n── phase B: interrupting the orchestrator's own turn ──");
const controller = new AbortController();
const callB = tool.execute(
	"call-b",
	{
		tasks: [{
			agent: agent.name,
			name: "beta",
			task: "Run the bash command `sleep 120`, wait for it to finish, then reply with exactly the single word SLOW.",
		}],
	},
	controller.signal,
	undefined,
	ctx,
);

const paneB = await waitChildPane([paneA]);
console.log(`child pane ${paneB}`);
await waitBusy(paneB);

controller.abort();
const resultB = await callB;
const textB = resultB.content[0]?.text ?? "";
const rowB = resultB.details.results?.[0];
assert.equal(rowB?.outcome, "interrupted", `the aborted child was reported as ${String(rowB?.outcome)}`);
// The same wording phase C asserts: the operator's interrupt closes the pane it
// stopped, so the label says so — not that it was left open, and not `cancelled`.
assert.equal(
	rowB?.status,
	"interrupted (pane closed)",
	`the aborted child is not shown as interrupted with its pane closed: ${String(rowB?.status)}`,
);
assert.equal(rowB?.cause, "interrupt", `the aborted child's cause is ${String(rowB?.cause)}, not interrupt`);
assert.equal(rowB?.paneId, paneB, `the aborted child reported pane ${String(rowB?.paneId)}, not ${paneB}`);
assert.equal(rowB?.summary, null, `an interrupted child carried a summary: ${JSON.stringify(rowB?.summary)}`);
assert.ok(textB.includes("interrupted (pane closed)"), `the aborted call did not report an interrupt:\n${textB}`);

// Aborting the call is the pane's fate: the relay it triggered typed one Esc into
// the child's pane and then closed it. The close is what proves the turn stopped —
// there is no screen left to read — and it is polled, because the close is issued
// fire-and-forget and a slow close must not flake.
await waitClosed(paneB);
console.log(`\nchild beta's pane ${paneB} is closed`);

// ── Phase C: Esc in the orchestrator's pane ─────────────────────────────────
// Phase B aborted the signal and let the relay it triggers type the Esc into the
// child. This phase reproduces the human's version whole, in the order the TUI
// produces it: the Esc typed into the orchestrator's own pane, then the call's
// signal aborted, against two children so "every live child" is really tested.
// The relay is left to reach every child on its own.
console.log("\n── phase C: esc in the orchestrator's pane, two children ──");
const batchTask =
	"Run the bash command `sleep 120`, wait for it to finish, then reply with exactly the single word SLOW.";
const controllerC = new AbortController();
const callC = tool.execute(
	"call-c",
	{
		tasks: [
			{ agent: agent.name, name: "gamma", task: batchTask },
			{ agent: agent.name, name: "delta", task: batchTask },
		],
	},
	controllerC.signal,
	undefined,
	ctx,
);

const paneC1 = await waitChildPane([paneA, paneB]);
const paneC2 = await waitChildPane([paneA, paneB]);
console.log(`child panes ${paneC1} and ${paneC2}`);
await waitBusy(paneC1);
await waitBusy(paneC2);
await sleep(1_000);

console.log(
	`typing esc into the orchestrator's pane ${orchestratorPaneId}, then aborting the call's signal — what the TUI does when the human interrupts`,
);
await run("herdr", ["pane", "send-keys", orchestratorPaneId, "esc"]);
controllerC.abort();

// The call has to return on the interrupt: the children are asleep for two
// minutes, so a wait that is not ended by the abort would hang here for good.
// Racing a bound turns that into a loud failure instead.
const resultC = await Promise.race([
	callC,
	sleep(30_000).then(() =>
		fail("the blocking call did not return 30s after the interrupt — the waits were not ended"),
	),
]);
const textC = resultC.content[0]?.text ?? "";
console.log(`\nthe interrupted batch returned:\n\n${textC}`);

if (resultC.isError) fail(`the interrupted batch came back as a tool error:\n\n${textC}`);
if (resultC.details.status !== "finished") {
	fail(`the interrupted batch is not a finished result but ${String(resultC.details.status)}`);
}
const rowsC = resultC.details.results ?? [];
if (rowsC.length !== 2) {
	fail(`the interrupted batch reported ${rowsC.length} children, not the two it was given:\n\n${textC}`);
}
const namesC = ["gamma", "delta"] as const;
rowsC.forEach((row, index) => {
	if (row.name !== namesC[index]) fail(`row ${index + 1} is ${row.name}, not ${namesC[index]}:\n\n${textC}`);
	if (row.outcome !== "interrupted") {
		fail(`child ${row.name} came back as ${row.outcome}, not interrupted:\n\n${textC}`);
	}
	if (row.status !== "interrupted (pane closed)") {
		fail(`child ${row.name} is not shown as interrupted with its pane closed: ${String(row.status)}`);
	}
	if (row.cause !== "interrupt") {
		fail(`child ${row.name} is interrupted for ${String(row.cause)}, not the operator's interrupt`);
	}
	if (row.summary !== null) {
		fail(
			`child ${row.name} came back with a summary although its turn was interrupted: ${JSON.stringify(row.summary)}`,
		);
	}
});
if (textC.includes("**Error:**")) fail(`an interrupted child is rendered as an error:\n\n${textC}`);
console.log("both rows are interrupted with no summary, and the batch is not a tool error");

// The batch must hand back exactly the two panes this phase saw open, not a
// repeated id and not a pane it never had.
const returnedC = new Set(rowsC.map((row) => row.paneId));
if (returnedC.size !== 2 || !returnedC.has(paneC1) || !returnedC.has(paneC2)) {
	fail(`the batch did not report the two panes it opened (${paneC1}, ${paneC2}): ${[...returnedC].join(", ")}`);
}

// Each pane must be closed: the relay typed into every live child and then closed
// it, so a pane still open would be a child left running with nobody waiting on
// it, and a pane still showing a running turn would mean the Esc reached nobody.
for (const row of rowsC) {
	await waitClosed(row.paneId);
	console.log(`child ${row.name}'s pane ${row.paneId} is closed`);
}
console.log("\nthe orchestrator's esc reached every child: both panes were closed behind it");

if (sent.length !== 0) {
	fail(`the orchestrator was messaged although results arrive as the tool result:\n\n${sent.join("\n\n")}`);
}
console.log("no orchestrator message was sent in any phase");

reap();
rmSync(sessionDir, { recursive: true, force: true });
console.log(
	"\nPASS an interrupt held the call open and the redirect reported; aborting the signal stopped its child's turn and closed its pane; the orchestrator's own esc stopped both children and closed both panes, returning interrupted rows with no summaries",
);
process.exit(0);
