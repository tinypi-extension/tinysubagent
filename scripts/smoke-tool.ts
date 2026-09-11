/**
 * End-to-end test of the tool as pi would actually drive it.
 *
 * `scripts/smoke.ts` reimplements the spawn recipe; this drives the real
 * extension instead. It loads `index.ts`, registers the tool through a stub
 * `ExtensionAPI`, calls `execute` with real arguments, and then waits to see the
 * steer message come out the other end.
 *
 * What this proves, with a real herdr pane and a real pi child:
 *
 *   - the tool is registered and its schema is accepted,
 *   - `execute` returns immediately with an acknowledgement, not a result,
 *   - the watcher resolves the child on its own,
 *   - exactly one steer message is delivered, with `triggerTurn` and `deliverAs:
 *     "steer"` — the options that make it wake the parent rather than queue,
 *   - the pane is gone once the child is done.
 *
 * It cannot prove pi acts on the steer; that is pi's side of the contract. It
 * proves every part of the message and the options handed to it.
 *
 * Usage: node scripts/smoke-tool.ts [agent] [--parallel] [--bogus]
 *
 * `--parallel` spawns two children at once. `--bogus` points the child at a model
 * that cannot exist and expects the failure path instead: a `failed` steer message
 * whose pane is deliberately left open for inspection.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { MIN_HERDR_VERSION, PLUGIN_ID, herdrPaneClose, herdrPaneExists, herdrPluginInfo, herdrStatus, isInsideHerdr, versionAtLeast } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/children/spawn.ts";

const agentName = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "worker";
const parallel = process.argv.includes("--parallel");
const expectFailure = process.argv.includes("--bogus");

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

// The failure path needs a profile whose model cannot resolve. The config path is
// overridable, so that can be arranged without touching the user's own file.
let configDir: string | null = null;
if (expectFailure) {
	configDir = join(tmpdir(), `tinysubagent-smoke-config-${Date.now()}`);
	mkdirSync(configDir, { recursive: true });
	const configFile = join(configDir, "tinysubagent.json");
	writeFileSync(
		configFile,
		JSON.stringify({
			enableProfiles: true,
			profiles: { bogus: { model: "oc-openai/definitely-not-a-real-model", thinking: "low" } },
		}),
		"utf8",
	);
	process.env.PI_TINYSUBAGENT_CONFIG = configFile;
}

function cleanup(): void {
	rmSync(sessionDir, { recursive: true, force: true });
	if (configDir) rmSync(configDir, { recursive: true, force: true });
}

// ── The stub surface pi would provide ───────────────────────────────────────
const tools: Record<string, unknown>[] = [];
const listeners = new Map<string, unknown>();
const sent: { message: { content: string; customType?: string }; options: unknown }[] = [];
let steerResolve: (() => void) | null = null;
const steered = new Promise<void>((resolve) => {
	steerResolve = resolve;
});

const api = {
	on(event: string, handler: unknown) {
		listeners.set(event, handler);
	},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string; customType?: string }, options: unknown) {
		sent.push({ message, options });
		steerResolve?.();
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

const params = expectFailure
	? {
			agent: agentName,
			task: "Reply with exactly the single word GAMMA.",
			profile: "bogus",
		}
	: parallel
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
const ack = await tool.execute("call-1", params, undefined, undefined, ctx);
const ackMs = Date.now() - startedAt;

console.log(`\n── execute() returned after ${ackMs}ms ──`);
console.log(ack.content[0]?.text ?? "(no text)");
console.log(`details: ${JSON.stringify(ack.details)}`);

// The whole point of fire-and-forget: the call must not wait for the subagent.
if (ackMs > 10_000) fail(`execute() blocked for ${ackMs}ms — it must return once the panes are open`);
if (ack.isError === true) fail("execute() reported an error");
if (sent.length !== 0) fail(`a steer message was sent before the child finished (${sent.length})`);
const spawned = (ack.details.spawned ?? []) as { paneId: string; warnings: string[] }[];
if (spawned.length !== (parallel ? 2 : 1)) fail(`expected ${parallel ? 2 : 1} spawned pane(s), got ${spawned.length}`);
// A role whose tools all resolve must not warn: a spurious warning here would mean
// the allowlist expansion is wrong, which is how a child silently loses tools.
if (!expectFailure) {
	for (const entry of spawned) {
		if (entry.warnings.length > 0) fail(`unexpected warning: ${entry.warnings.join("; ")}`);
	}
}

const timeout = setTimeout(() => fail("timed out after 180s waiting for the steer message"), 180_000);
await steered;
clearTimeout(timeout);

// ── The steer message ───────────────────────────────────────────────────────
assert.equal(sent.length, 1, `expected exactly one combined steer message, got ${sent.length}`);
const [steer] = sent;
if (!steer) fail("no steer message");

console.log(`\n── the steer message, ${((Date.now() - startedAt) / 1000).toFixed(1)}s after execute() ──`);
console.log(`customType: ${steer.message.customType}`);
console.log(`options:    ${JSON.stringify(steer.options)}`);
console.log(steer.message.content);

// These two options are the entire wake-up contract.
assert.deepEqual(steer.options, { triggerTurn: true, deliverAs: "steer" });
assert.equal(steer.message.customType, "tinysubagent_result");

const wanted = expectFailure ? ["failed (error)", "**Error:**"] : parallel ? ["ALPHA", "BETA"] : ["PONG"];
for (const fragment of wanted) {
	assert.ok(steer.message.content.includes(fragment), `steer message is missing ${fragment}`);
}
if (!expectFailure) {
	// A child that skips the report means the hand-back contract is broken, not that
	// the model was conflicted: the prompts no longer tell it to avoid tools.
	assert.ok(
		steer.message.content.includes("completed (reported)"),
		`steer message is not labelled \`completed (reported)\` — the child fell back to scraping its session file:\n${steer.message.content}`,
	);
}
// Every child must be labelled, which is what makes one message usable for a batch.
for (const label of parallel ? ["alpha", "beta"] : ["worker"]) {
	assert.ok(steer.message.content.includes(label), `steer message is missing the label ${label}`);
}

// ── The pane ────────────────────────────────────────────────────────────────
// A finished child's pane must not outlive it; a failed one is deliberately left
// open so the error stays readable, and this is the case that used to hang.
const paneIds = spawned.map((entry) => entry.paneId);
await new Promise((resolve) => setTimeout(resolve, 1_000));
for (const paneId of paneIds) {
	const alive = await herdrPaneExists(paneId);
	console.log(`pane ${paneId} still open: ${alive}`);
	if (expectFailure) continue;
	assert.notEqual(alive, true, `pane ${paneId} was left open after the job finished`);
}

// A failed run leaves a pane, so reap it here: the harness must not change the
// state of the user's herdr.
if (expectFailure) {
	for (const paneId of paneIds) {
		const closed = await herdrPaneClose(paneId);
		console.log(`reaped pane ${paneId}: ${closed}`);
	}
}

cleanup();
console.log(
	expectFailure
		? "\nPASS a failed subagent was reported with its error, and its pane was left open"
		: "\nPASS the registered tool spawned, waited, and delivered one steer message",
);
process.exit(0);
