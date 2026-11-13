/**
 * Interrupt smoke test: the two interrupts the unit tests cannot reach, because
 * both depend on how real pi labels a stopped turn.
 *
 * Phase A — Esc in the child's pane. That stops the child's turn without ending
 * the child: it stays at its prompt, the blocking call keeps waiting, the
 * orchestrator is told nothing, and the same child still reports after a
 * redirect. That report ends the call as `completed (reported)` and closes the
 * pane, because the child is gone.
 *
 * Phase B — Esc in the orchestrator. Aborting the call's own signal ends the
 * wait as `interrupted`; the child is left running with its pane open, and
 * nothing is delivered later.
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
		details: { spawned?: { paneId: string }[]; results?: { name: string; outcome: string; via?: string }[] };
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

async function paneText(paneId: string): Promise<string> {
	try {
		const { stdout } = await run("herdr", ["pane", "read", paneId, "--format", "text", "--lines", "80"]);
		return stdout;
	} catch {
		return "";
	}
}

async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(500);
	}
	return false;
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
		if ((await paneText(paneId)).includes("sleep")) {
			console.log(`child is mid-work after ${i + 1}s (bash sleep visible in its pane)`);
			return;
		}
	}
	fail("the child never started its bash call — cannot interrupt anything");
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
if ((await paneText(paneA)).includes("sleep")) console.log("(pane still shows the aborted call)");

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

// ── Phase B: Esc in the orchestrator ────────────────────────────────────────
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
assert.ok(textB.includes("interrupted"), `the aborted call did not report an interrupt:\n${textB}`);
assert.equal(resultB.details.results?.[0]?.outcome, "interrupted", "the aborted child was reported as finished");

// The call's signal is not the pane's fate: the child keeps running.
await sleep(2_000);
const aliveB = await herdrPaneExists(paneB);
console.log(`interrupted child's pane still open: ${aliveB}`);
if (aliveB !== true) fail("aborting the call closed the child's pane");

if (sent.length !== 0) {
	fail(`the orchestrator was messaged although results arrive as the tool result:\n\n${sent.join("\n\n")}`);
}
console.log("no orchestrator message was sent in either phase");

reap();
rmSync(sessionDir, { recursive: true, force: true });
console.log(
	"\nPASS an interrupt held the call open and the redirect reported; aborting the call interrupted the batch and left its pane open",
);
process.exit(0);
