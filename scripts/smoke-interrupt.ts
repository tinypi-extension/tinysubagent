/**
 * Interrupt smoke test: the workflow of pressing Esc in a child's pane to redirect
 * it, which the unit tests cannot reach — it depends on how real pi labels an
 * interrupt, and that is not what its stop reason says.
 *
 * Drives a real child, lets it start real work, presses Esc in its pane exactly as
 * a user would, then asserts the orchestrator heard nothing — and that the same
 * child still accepts a redirect and reports when it is done.
 *
 * Usage: node scripts/smoke-interrupt.ts [agent]
 */

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/agents.ts";
import { herdrPaneExists, herdrPluginInfo, PLUGIN_ID } from "../src/herdr.ts";
import { TOOL_NAME } from "../src/spawn.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
	console.error(`\nFAIL ${message}`);
	process.exit(1);
}

const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`herdr plugin ${PLUGIN_ID} is missing or disabled`);

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
		console.log(`\n!!! STEER MESSAGE ARRIVED (${sent.length}) !!!\n${message.content}`);
	},
	getAllTools: () => ["read", "bash", TOOL_NAME].map((name) => ({ name })),
};

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	thinkingLevel: "low",
	model: { provider: "oc-openai", id: "deepseek-flash" },
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
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
};

const ack = await tool.execute(
	"call-1",
	{
		agent: agent.name,
		task: "Run the bash command `sleep 120`, wait for it to finish, then reply with exactly the single word SLOW.",
	},
	undefined,
	undefined,
	ctx,
);
const paneId = (ack.details.spawned as { paneId: string }[])[0]?.paneId;
if (!paneId) fail(`nothing was spawned: ${JSON.stringify(ack.details)}`);
console.log(`spawned pane ${paneId}`);

// This harness must never leave a live child behind, however it dies — including
// being interrupted itself, which is how the previous orphaned pane happened.
let reaped = false;
function reap(): void {
	if (reaped) return;
	reaped = true;
	try {
		execFileSync("herdr", ["pane", "close", paneId!], { stdio: "ignore" });
	} catch {
		// Already gone: the interesting case, so nothing to report.
	}
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {
	reap();
	process.exit(130);
});
process.on("exit", reap);

async function paneText(): Promise<string> {
	try {
		const { stdout } = await run("herdr", ["pane", "read", paneId!, "--format", "text", "--lines", "80"]);
		return stdout;
	} catch {
		return "";
	}
}

// Wait until the child is genuinely mid-work, so the Esc lands on a running turn.
let busy = false;
for (let i = 0; i < 60; i += 1) {
	await sleep(1_000);
	if ((await paneText()).includes("sleep")) {
		busy = true;
		console.log(`child is mid-work after ${i + 1}s (bash sleep visible in its pane)`);
		break;
	}
}
if (!busy) fail("the child never started its bash call — cannot interrupt anything");
await sleep(2_000);

// ── The user's action: Esc, to redirect the child ───────────────────────────
console.log("\n── sending esc to the child pane ──");
await run("herdr", ["pane", "send-keys", paneId, "esc"]);

const afterEsc = 8_000;
console.log(`waiting ${afterEsc / 1000}s to see whether the orchestrator is told anything...`);
await sleep(afterEsc);

if (sent.length !== 0) {
	fail(`the orchestrator was steered after an interrupt — this is the bug.\n\n${sent.join("\n\n")}`);
}
console.log("no steer message after the interrupt");

const stillAlive = await herdrPaneExists(paneId);
console.log(`child pane still open: ${stillAlive}`);
if (stillAlive !== true) fail("the child pane closed on interrupt — the user cannot redirect it");
if ((await paneText()).includes("sleep")) console.log("(pane still shows the aborted call)");

// ── The redirect: type into the child and let it finish ─────────────────────
console.log("\n── redirecting the child ──");
await run("herdr", ["pane", "run", paneId, "Reply with exactly the single word PONG. Do not explain."]);

for (let i = 0; i < 120 && sent.length === 0; i += 1) await sleep(1_000);
if (sent.length === 0) fail("the redirected child never reported — the interrupt wedged the batch");

const report = sent.join("\n");
assert.ok(report.includes("PONG"), `the redirect's result is missing:\n${report}`);
assert.ok(report.includes("completed"), `the redirect was not reported as completed:\n${report}`);
console.log("\n✓ the redirected child reported normally");

reap();
rmSync(sessionDir, { recursive: true, force: true });
console.log("\nPASS an interrupt told the orchestrator nothing, and the child still finished after a redirect");
process.exit(0);
