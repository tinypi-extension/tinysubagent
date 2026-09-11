/**
 * Layout smoke test: does real herdr geometry match the two-column rule?
 *
 * `test/layout.test.ts` pins the arithmetic against hand-written rects, and
 * `test/spawn.test.ts` pins the sequencing against a scripted herdr stub. Neither
 * can prove the thing that actually matters: that the real `herdr pane resize`
 * divider arithmetic lands where the planner thinks it does. This is the honest
 * one — it spawns two trivial children through the real `spawnOne` path with a
 * real tracker, then reads `pane layout` and asserts the measured rects:
 *
 *   - the orchestrator holds 60% of its split rect, within ±1 column,
 *   - the two sub panes are within ±1 row of each other,
 *   - both subs share one column, to the right of the orchestrator.
 *
 * Unlike `scripts/smoke.ts`, a missing environment is a skip, not a failure: no
 * herdr session or an unlinked `tinysubagent-panes` plugin means there is nothing
 * to measure, so it exits 0 with a `SKIP` line rather than looking broken. Run it
 * from a herdr pane for a real assertion. A real assertion failure exits non-zero.
 *
 * Every pane it opens is closed again on the success and failure paths, so the
 * user's herdr is left exactly as it was found.
 *
 * Usage: node scripts/smoke-layout.ts [agent] [profile]
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "../src/agents.ts";
import { loadConfig } from "../src/config.ts";
import {
	currentPaneId,
	herdrPaneClose,
	herdrPaneLayout,
	herdrPluginInfo,
	herdrStatus,
	isInsideHerdr,
	MIN_HERDR_VERSION,
	PLUGIN_ID,
	versionAtLeast,
} from "../src/herdr.ts";
import { LiveSubPanes } from "../src/layout.ts";
import { errorMessage, spawnOne, type SpawnContext } from "../src/spawn.ts";

const agentName = process.argv[2] ?? "worker";
const profileName = process.argv[3] ?? "light";

/** A missing environment is not a failure: say so and leave cleanly. */
function skip(reason: string): never {
	console.log(`SKIP smoke-layout — ${reason}`);
	process.exit(0);
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pad(value: number): string {
	return String(value).padStart(4);
}

// ── Preconditions: herdr is an environment, not a test subject ──────────────
if (!isInsideHerdr()) skip("not running inside herdr (HERDR_ENV/HERDR_PANE_ID/HERDR_SOCKET_PATH unset)");

const status = await herdrStatus();
if (!status?.running) skip("herdr server is not reachable");
if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
	skip(`herdr ${status.version ?? "unknown"} < ${MIN_HERDR_VERSION}`);
}

const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) skip(`herdr plugin ${PLUGIN_ID} is missing or disabled (run \`npm run link-plugin\`)`);

const orchestratorPaneId = currentPaneId(process.env);
if (!orchestratorPaneId) skip("HERDR_PANE_ID is unset, so there is no orchestrator pane to measure");

// ── State the run owns, so cleanup is exact ─────────────────────────────────
const cwd = process.cwd();
const sessionDir = join(getAgentDir(), "sessions", "--tinysubagent-smoke--");
const sessionId = `smoke-layout-${Date.now()}`;
/** Pane ids this run opened, in spawn order; the only panes it may close. */
const opened: string[] = [];

/** Close every pane this run opened, then drop the session dir. Idempotent. */
async function reap(): Promise<void> {
	for (const paneId of opened) {
		try {
			await herdrPaneClose(paneId);
		} catch (error) {
			console.error(`cleanup: could not close pane ${paneId}: ${errorMessage(error)}`);
		}
	}
	rmSync(sessionDir, { recursive: true, force: true });
}

let failure: string | null = null;
try {
	// ── The real spawn recipe, exactly as `scripts/smoke.ts` drives it ──────
	const { config, warnings } = loadConfig(cwd, getAgentDir());
	for (const warning of warnings) console.log(`config warning: ${warning}`);
	config.enableProfiles = true;
	const chosen = config.profiles[profileName];
	if (!chosen) {
		throw new Error(`no profile "${profileName}" (have: ${Object.keys(config.profiles).join(", ")})`);
	}

	const discovered = discoverAgents(cwd);
	const agent = discovered.agents.find((entry) => entry.name === agentName);
	if (!agent) {
		throw new Error(`no agent "${agentName}" (have: ${discovered.agents.map((entry) => entry.name).join(", ")})`);
	}

	mkdirSync(sessionDir, { recursive: true });

	const context: SpawnContext = {
		cwd,
		agentDir: getAgentDir(),
		agentDirOverride: null,
		sessionDir,
		sessionId,
		env: process.env,
		allToolNames: ["read", "bash", "grep", "find", "ls"],
		agents: discovered.agents,
		config,
		parentModel: chosen.model,
		parentThinking: chosen.thinking,
		// The real thing: placement and the resize pass only run when a tracker is
		// present, so a script without one would prove nothing about the layout.
		columns: new LiveSubPanes(),
	};

	// Two trivial children. They are closed as soon as the rects are read, so the
	// tasks never need to finish; the point is the panes, not the answers.
	const plan = [
		{
			agent: agentName,
			name: "layout-a",
			task: "Reply with exactly the single word ALPHA. Do not use any tools. Do not explain.",
			profile: profileName,
		},
		{
			agent: agentName,
			name: "layout-b",
			task: "Reply with exactly the single word BETA. Do not use any tools. Do not explain.",
			profile: profileName,
		},
	];

	console.log(`herdr ${status.version}, plugin ${PLUGIN_ID} ok, orchestrator pane ${orchestratorPaneId}`);
	console.log(`spawning ${plan.length} children through spawnOne with a live tracker: ${plan.map((entry) => entry.name).join(", ")}`);
	for (const request of plan) {
		const started = await spawnOne(request, context);
		if (!started.ok) throw new Error(`spawn of ${request.name} failed: ${started.error}`);
		opened.push(started.running.paneId);
		console.log(`pane ${started.running.paneId} up for ${request.name}`);
	}

	// ── Measure ─────────────────────────────────────────────────────────────
	const layout = await herdrPaneLayout(orchestratorPaneId);
	if (!layout) throw new Error("could not read `pane layout` after the spawns");

	console.log("\n── measured pane layout (tab-wide) ──");
	for (const pane of layout.panes) {
		const role =
			pane.paneId === orchestratorPaneId
				? "  <- orchestrator"
				: opened.includes(pane.paneId)
					? "  <- sub"
					: "";
		console.log(
			`  ${pane.paneId.padEnd(10)} x=${pad(pane.rect.x)} y=${pad(pane.rect.y)} w=${pad(pane.rect.width)} h=${pad(pane.rect.height)}${role}`,
		);
	}

	const orches = layout.panes.find((pane) => pane.paneId === orchestratorPaneId);
	const subs = opened.map((id) => layout.panes.find((pane) => pane.paneId === id));
	const [subA, subB] = subs;
	check(orches, `orchestrator pane ${orchestratorPaneId} is missing from the layout`);
	check(subA, `sub pane ${opened[0]} is missing from the layout`);
	check(subB, `sub pane ${opened[1]} is missing from the layout`);

	const splitWidth = orches.rect.width + subA.rect.width;
	const share = splitWidth === 0 ? 0 : (orches.rect.width / splitWidth) * 100;
	console.log(`\n  orchestrator ${orches.rect.width}/${splitWidth} cols = ${share.toFixed(1)}% (want 60% ±1 col)`);
	console.log(`  sub heights ${subA.rect.height} and ${subB.rect.height} (want within ±1 row)`);
	console.log(`  sub columns x=${subA.rect.x} and x=${subB.rect.x}, orchestrator x=${orches.rect.x}`);

	// ── Assert on the measured rects ────────────────────────────────────────
	check(
		Math.abs(orches.rect.width - 0.6 * splitWidth) <= 1,
		`orchestrator is ${orches.rect.width} of ${splitWidth} cols (${share.toFixed(1)}%), want 60% ±1 col`,
	);
	check(
		Math.abs(subA.rect.height - subB.rect.height) <= 1,
		`sub panes are ${subA.rect.height} and ${subB.rect.height} rows tall, want within ±1 row`,
	);
	check(subA.rect.x === subB.rect.x, `sub panes are not in one column: x=${subA.rect.x} vs x=${subB.rect.x}`);
	check(
		subA.rect.x > orches.rect.x,
		`sub column (x=${subA.rect.x}) is not to the right of the orchestrator (x=${orches.rect.x})`,
	);
} catch (error) {
	failure = errorMessage(error);
} finally {
	await reap();
}

if (failure) {
	console.error(`\nFAIL smoke-layout — ${failure}`);
	process.exit(1);
}

console.log("\nPASS orchestrator at 3/5 of the split, both subs equal-height in one right-hand column, all panes closed");
process.exit(0);
