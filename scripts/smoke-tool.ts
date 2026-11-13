/**
 * End-to-end test of the tool as pi would actually drive it.
 *
 * `scripts/smoke.ts` reimplements the spawn recipe; this drives the real
 * extension instead. It loads `index.ts`, registers the tool through a stub
 * `ExtensionAPI`, calls `execute` with real arguments, and waits for the call to
 * return the whole batch's report.
 *
 * What this proves, with a real herdr pane and a real pi child:
 *
 *   - the tool is registered and its schema is accepted,
 *   - `execute` blocks until the child is done and returns its report as the
 *     tool result, rather than acknowledging and delivering later,
 *   - nothing is sent to the parent session — no steer message at all,
 *   - the pane is gone once the child is done.
 *
 * It cannot prove the model reads the result; that is pi's side of the contract.
 * It proves the call carries every part of the report.
 *
 * Usage: node scripts/smoke-tool.ts [agent] [--parallel]
 *
 * `--parallel` spawns two children at once. A child that errors reports as a
 * failure inside the returned result. `npm run smoke:provider-error` exercises
 * the never-started hold on purpose.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { MIN_HERDR_VERSION, PLUGIN_ID, herdrPaneExists, herdrPluginInfo, herdrStatus, isInsideHerdr, versionAtLeast } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/types.ts";

const agentName = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "worker";
const parallel = process.argv.includes("--parallel");

function fail(message: string): never {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

// ── Preconditions ────────────────────────────────────────────────────────────
if (!isInsideHerdr()) fail("not running inside herdr — this harness needs a pane to split");

const status = await herdrStatus();
if (!status?.running) fail("herdr server is not running");
if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
	fail(`herdr >= ${MIN_HERDR_VERSION} required, found ${status.version ?? "unknown"}`);
}
const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`herdr plugin ${PLUGIN_ID} is missing or disabled`);

const { agents } = discoverAgents(process.cwd());
const agent = agents.find((entry) => entry.name === agentName);
if (!agent) fail(`no agent "${agentName}" (have: ${agents.map((entry) => entry.name).join(", ")})`);
console.log(`herdr ${status.version}, plugin ok, agent \`${agent.name}\` (${agent.tools?.join(", ") ?? "all tools"})`);

// ── A session dir of our own, so nothing lands in the user's real sessions ──
const sessionDir = join(getAgentDir(), "sessions", "--tinysubagent-smoke--");
mkdirSync(sessionDir, { recursive: true });
const sessionId = `smoke-tool-${Date.now()}`;
const sessionFile = join(sessionDir, `${sessionId}.jsonl`);

function cleanup(): void {
	rmSync(sessionDir, { recursive: true, force: true });
}

// ── The stub surface pi would provide ───────────────────────────────────────
const tools: Record<string, unknown>[] = [];
const listeners = new Map<string, unknown>();
// Kept only to prove it stays empty: the call delivers its result, so nothing is
// ever pushed into the parent session.
const sent: { message: { content: string; customType?: string }; options: unknown }[] = [];

const api = {
	on(event: string, handler: unknown) {
		listeners.set(event, handler);
	},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string; customType?: string }, options: unknown) {
		sent.push({ message, options });
	},
	getAllTools() {
		// As a real session would report them: the spawn tool itself is among them,
		// along with the MCP tools a role's wildcard is expected to expand to.
		const names = [
			"read",
			"write",
			"edit",
			"bash",
			"grep",
			"find",
			"ls",
			"codegraph_codegraph_callers",
			"codegraph_codegraph_callees",
			"codegraph_codegraph_impact",
			"codegraph_codegraph_files",
			TOOL_NAME,
		];
		return names.map((name) => ({ name }));
	},
};

// The parent session's context, as far as `execute` reads it.
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

// ── Register, then call the tool exactly as pi would ────────────────────────
tinysubagent(api as never);
if (tools.length !== 1) fail(`expected exactly one registered tool, got ${tools.length}`);
const tool = tools[0] as {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }>;
};
assert.equal(tool.name, TOOL_NAME);
console.log(`registered \`${tool.name}\`; listeners: ${[...listeners.keys()].join(", ")}`);

const params = parallel
	? {
			tasks: [
				{ agent: agentName, name: "alpha", task: "Reply with exactly the single word ALPHA." },
				{ agent: agentName, name: "beta", task: "Reply with exactly the single word BETA." },
			],
		}
	: {
			agent: agentName,
			task: "Reply with exactly the single word PONG. Do not explain.",
		};

const startedAt = Date.now();
const result = await tool.execute("call-1", params, undefined, undefined, ctx);
const elapsedMs = Date.now() - startedAt;

console.log(`\n── execute() returned after ${(elapsedMs / 1000).toFixed(1)}s ──`);
console.log(result.content[0]?.text ?? "(no text)");

// The whole point of the change: the call itself is the delivery.
if (result.isError === true) fail("execute() reported an error");
if (sent.length !== 0) fail(`something was sent to the parent session (${sent.length}) — the result is the return value`);
const spawned = (result.details.spawned ?? []) as { paneId: string; warnings: string[] }[];
if (spawned.length !== (parallel ? 2 : 1)) fail(`expected ${parallel ? 2 : 1} spawned pane(s), got ${spawned.length}`);
// A role whose tools all resolve must not warn: a spurious warning here would mean
// the allowlist expansion is wrong, which is how a child silently loses tools.
for (const entry of spawned) {
	if (entry.warnings.length > 0) fail(`unexpected warning: ${entry.warnings.join("; ")}`);
}

// The report is the result, so it has to carry every part the model needs.
const report = result.content[0]?.text ?? "";
const wanted = parallel ? ["ALPHA", "BETA"] : ["PONG"];
for (const fragment of wanted) {
	if (!report.includes(fragment)) fail(`the result is missing ${fragment}`);
}
// A child that skips the report means the hand-back contract is broken, not that
// the model was conflicted: the prompts no longer tell it to avoid tools.
if (!report.includes("completed (reported)")) {
	fail(`the child did not report — it fell back to scraping its session file:\n${report}`);
}
// Every child must be labelled, which is what makes one result usable for a batch.
for (const label of parallel ? ["alpha", "beta"] : ["worker"]) {
	if (!report.includes(label)) fail(`the result is missing the label ${label}`);
}

// ── The pane ────────────────────────────────────────────────────────────────
// A finished child's pane must not outlive the wait. A never-started child would
// keep it, which is the provider-error smoke's subject, not this one.
const paneIds = spawned.map((entry) => entry.paneId);
await new Promise((resolve) => setTimeout(resolve, 1_000));
for (const paneId of paneIds) {
	const alive = await herdrPaneExists(paneId);
	console.log(`pane ${paneId} still open: ${alive}`);
	assert.notEqual(alive, true, `pane ${paneId} was left open after the job finished`);
}

cleanup();
console.log("\nPASS the registered tool blocked, returned the report, and sent nothing");
process.exit(0);
