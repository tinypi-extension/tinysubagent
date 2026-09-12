/**
 * End-to-end smoke test.
 *
 * Drives the real spawn recipe against a live herdr server: it plans the
 * artifacts, generates the wrapper, opens a plugin pane, lets a real `pi` child
 * run a trivial task, and then waits for the watcher to classify the result.
 *
 * This is the only test that can catch the failures that matter most and are
 * invisible to unit tests — a dispatcher that never runs, a child that never
 * starts, a sidecar that never lands, a pane that never closes.
 *
 * Usage: node scripts/smoke.ts [agent] [profile] [--parallel]
 *
 * Pass the profile name `bogus` to exercise the failure path instead: it points
 * the child at a model that cannot exist, so the run is expected to end in
 * `failed` with the pane left open for inspection.
 *
 * `--parallel` spawns three children at once — two healthy and one that cannot
 * succeed — so both the combined single-message report and the rule that one
 * broken child never holds up the others are exercised for real.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../src/config/agents.ts";
import { loadConfig } from "../src/config/config.ts";
import {
	herdrPaneClose,
	herdrPaneExists,
	herdrPluginInfo,
	herdrStatus,
	isInsideHerdr,
	MIN_HERDR_VERSION,
	PLUGIN_ID,
	versionAtLeast,
} from "../src/herdr/cli.ts";
import { spawnOne } from "../src/children/spawn.ts";
import { buildResultText } from "../src/present/steer.ts";
import { waitForSubagent } from "../src/children/watcher.ts";

const agentName = process.argv[2] ?? "worker";
const profileName = process.argv[3] ?? "light";
const parallel = process.argv.includes("--parallel");
const sessionDir = join(getAgentDir(), "sessions", "--tinysubagent-smoke--");
const sessionId = `smoke-${Date.now()}`;

/** Panes opened so far, so a failure part-way through can reap them again. */
const runnings: RunningSubagent[] = [];

function fail(message: string): never {
	console.error(`FAIL ${message}`);
	for (const running of runnings) void herdrPaneClose(running.paneId);
	process.exit(1);
}

if (!isInsideHerdr()) fail("not running inside herdr (HERDR_ENV/HERDR_PANE_ID/HERDR_SOCKET_PATH)");

const status = await herdrStatus();
if (!status?.running) fail("herdr server not reachable");
if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
	fail(`herdr ${status.version ?? "?"} < ${MIN_HERDR_VERSION}`);
}
const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`plugin ${PLUGIN_ID} not installed/enabled`);
console.log(`herdr ${status.version}, plugin ${PLUGIN_ID} ok`);

const { config, warnings } = loadConfig(process.cwd(), getAgentDir());
for (const warning of warnings) console.log(`config warning: ${warning}`);

// `bogus` deliberately points at a model that cannot resolve, so the child dies
// on startup: this is how the failure classification gets exercised end to end.
const expectFailure = profileName === "bogus";
config.enableProfiles = true;
config.profiles.bogus = { model: "oc-openai/definitely-not-a-real-model", thinking: "low" };

const chosen = config.profiles[profileName];
if (!chosen) {
	fail(`no profile "${profileName}" (have: ${Object.keys(config.profiles).join(", ")})`);
}

const cwd = process.cwd();
const discovered = discoverAgents(cwd);
const agent = discovered.agents.find((entry) => entry.name === agentName);
if (!agent) fail(`no agent "${agentName}" (have: ${discovered.agents.map((a) => a.name).join(", ")})`);

mkdirSync(sessionDir, { recursive: true });

const context = {
	cwd,
	agentDir: getAgentDir(),
	agentDirOverride: null,
	sessionDir,
	sessionId,
	env: process.env,
	allToolNames: ["read", "bash", "grep", "find", "ls"],
	agents: discovered.agents,
	config,
	parentModel: chosen?.model,
	parentThinking: chosen?.thinking,
};

const request = {
	agent: agentName,
	task: "Call subagent_report with the result PONG. Use no other tools. Do not explain.",
	name: "smoke",
	profile: config.enableProfiles ? profileName : undefined,
};

const plan = parallel
	? [
			{
				agent: agentName,
				name: "alpha",
				task: "Call subagent_report with the result ALPHA. Use no other tools.",
				profile: config.enableProfiles ? profileName : undefined,
			},
			{
				agent: agentName,
				name: "beta",
				task: "Call subagent_report with the result BETA. Use no other tools.",
				profile: config.enableProfiles ? profileName : undefined,
			},
			{ agent: agentName, name: "broken", task: "Reply with exactly the single word GAMMA.", profile: "bogus" },
		]
	: [request];

console.log(`spawning ${plan.length} child(ren): ${plan.map((entry) => `${entry.name}[${entry.profile ?? "inherited"}]`).join(", ")}`);
for (const entry of plan) {
	const started = await spawnOne(entry, context);
	if (!started.ok) fail(`spawn of ${entry.name} failed: ${started.error}`);
	runnings.push(started.running);
	console.log(`pane ${started.running.paneId} up for ${entry.name}`);
}

const timeout = setTimeout(() => {
	console.error(`FAIL timed out after 180s waiting for ${runnings.length} subagent(s)`);
	for (const running of runnings) void herdrPaneClose(running.paneId);
	process.exit(1);
}, 180_000);

const settled = await Promise.all(
	runnings.map(async (running) => ({
		name: running.name,
		agent: running.agent,
		profile: running.profile,
		paneId: running.paneId,
		task: running.task,
		sessionFile: running.sessionFile,
		outcome: await waitForSubagent(running),
		elapsedMs: Date.now() - running.startedAt,
	})),
);
clearTimeout(timeout);

console.log("\n── outcomes ──");
for (const result of settled) {
	console.log(`${result.name}: ${result.outcome.kind} in ${(result.elapsedMs / 1000).toFixed(1)}s`);
}

console.log(`\n── the single combined steer message ──\n${buildResultText(settled)}`);

// A finished pane closes itself; a failed one is left open on purpose. Reap
// every pane here so the user's herdr is left exactly as it was found.
for (const running of runnings) {
	const alive = await herdrPaneExists(running.paneId);
	if (alive !== false) await herdrPaneClose(running.paneId);
}

rmSync(sessionDir, { recursive: true, force: true });

// Expected shape: healthy children complete, the broken one fails, and every
// child is accounted for in the one message.
const completed = settled.filter((result) => result.outcome.kind === "completed").length;
const failed = settled.filter((result) => result.outcome.kind === "failed").length;
const wantCompleted = parallel ? 2 : expectFailure ? 0 : 1;
const wantFailed = parallel ? 1 : expectFailure ? 1 : 0;

if (completed !== wantCompleted || failed !== wantFailed) {
	console.error(`\nFAIL expected ${wantCompleted} completed / ${wantFailed} failed, got ${completed}/${failed}`);
	process.exit(2);
}
console.log(`\nPASS ${completed} completed, ${failed} failed, all reported together`);
process.exit(0);
