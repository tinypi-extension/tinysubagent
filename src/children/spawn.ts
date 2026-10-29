/**
 * Turning a validated request into a running pane.
 *
 * This module owns the whole spawn recipe: resolve the role, resolve the
 * profile, plan the artifact paths, generate the wrapper script, write it, and
 * ask herdr for a pane. It is deliberately free of any pi extension API so the
 * recipe can be exercised directly by tests and by the smoke harness.
 *
 * Nothing here waits for a child. Waiting is the watcher's job.
 */

import { buildLaunchPaths, buildLaunchScript, buildTaskMarkdown, resolveLaunchPrefix, runId, writeLaunchFiles } from "./launch.ts";
import { harnessFor } from "./harness/index.ts";
import { agyBinAvailable } from "./harness/agy.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { childExtensionPath } from "../paths.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentPaneId, herdrPaneLayout, herdrPaneOpen, herdrPaneRename, herdrPaneResize } from "../herdr/cli.ts";
import { LiveSubPanes, planPlacement, planResizes, type Placement } from "../herdr/layout.ts";
import { resolveProfile } from "../config/profiles.ts";
import { declaresSpawnTool, resolveToolList } from "../tool-list.ts";
import { isThinkingLevel, TOOL_NAME, type ThinkingLevel } from "../types.ts";
import { errorMessage, type SpawnContext, type SpawnFailed, type SpawnRequest, type Spawned } from "./contract.ts";

/** Name of the spawn tool, used for the nesting guard below. */
export { TOOL_NAME };

/**
 * The child hook, passed as `-e` to every child. Sourced from `./paths.ts` so
 * the target cannot drift when this module is relocated.
 */
export { childExtensionPath };

export async function spawnOne(request: SpawnRequest, context: SpawnContext): Promise<Spawned | SpawnFailed> {
	const agent = context.agents.find((entry) => entry.name === request.agent);
	if (!agent) {
		const available = context.agents.map((entry) => `\`${entry.name}\``).join(", ") || "(none)";
		return { ok: false, error: `unknown agent "${request.agent}". Available: ${available}.` };
	}

	const profile = resolveProfile(context.config, request.profile, {
		model: context.parentModel,
		thinking: context.parentThinking,
	});
	if (!profile.ok) return { ok: false, error: profile.error };

	const harness = harnessFor(profile);
	const binary = harness.resolveBin(context.env);
	if (profile.harness === "agy" && !agyBinAvailable(binary, context.env)) {
		const paths = buildLaunchPaths({ sessionDir: context.sessionDir, sessionId: context.sessionId, agentDir: context.agentDir, cwd: context.cwd, name: request.name, id: runId() });
		writeLaunchFiles([{ path: paths.taskFile, content: buildTaskMarkdown({ body: agent.body, task: request.task, harness: profile.harness }) }]);
		try {
			mkdirSync(path.dirname(paths.reportFile), { recursive: true });
			writeFileSync(paths.reportFile, JSON.stringify({ type: "failed", reason: "error", message: `agy executable not found: ${binary}` }), { flag: "wx" });
		} catch { /* Preserve an existing report; the direct tool error remains sufficient. */ }
		return { ok: false, error: `agy executable not found: ${binary}` };
	}
	const warnings: string[] = [];
	const floor = context.config.defaultTools ?? [];
	let tools: string[] | null = null;
	// Whether the role itself puts the spawn tool in its child's allowlist. Read
	// from the role's declaration, never from `tools`: the resolver drops a floor
	// entry naming it, so the composed list would make ambient config look like a
	// role's mistake.
	let wantsSpawnTool = false;
	if (profile.harness === "agy") {
		// agy has no `--tools` flag, so neither list can be enforced there. Each one
		// the caller did ask for is reported rather than silently dropped.
		if (agent.tools && agent.tools.length > 0) {
			warnings.push(`agent "${agent.name}": tools list ignored because the agy harness cannot enforce it.`);
		}
		if (floor.length > 0) {
			warnings.push(`agent "${agent.name}": defaultTools floor ignored because the agy harness cannot enforce it.`);
		}
	} else {
		// One resolver decides the allowlist, including whether there is one at all.
		// `tools` stays null when there is none, so the child gets no `--tools` flag.
		const resolved = resolveToolList({
			floor,
			declared: agent.tools,
			registry: context.allToolNames,
			role: agent.name,
			// Shared by every spawn of this session: the resolver uses it to report
			// registry-dependent floor warnings once instead of on every ack.
			reportedWarnings: context.reportedWarnings,
		});
		warnings.push(...resolved.warnings);
		if (resolved.allowlist) tools = resolved.tools;
		// Expansion, not a literal match: a role's `*` covers the spawn tool too,
		// while `-subagent` removes it again.
		wantsSpawnTool = declaresSpawnTool(agent.tools, context.allToolNames);
	}

	// Nested delegation is refused rather than half-supported. A grandchild's
	// result lands in the subagent's own session, and the batch contract has no
	// way to carry it up: the orchestrator's steer delivers what its direct
	// children report, and the subagent has no report that carries a
	// grandchild's payload. Failing the spawn says so, instead of losing work
	// quietly later.
	if (wantsSpawnTool) {
		return {
			ok: false,
			error:
				`agent "${agent.name}" lists \`${TOOL_NAME}\` in its tools, so it could spawn subagents of its own. ` +
				"Nested delegation is not supported yet: a grandchild's result lands in the " +
				"subagent's own session, and nothing carries it up to the orchestrator. " +
				`Remove \`${TOOL_NAME}\` from that role.`,
		};
	}

	// The one entry a role's list cannot have is the way to hand the result back.
	// The resolver appends it whenever an allowlist exists.
	const id = runId();
	const paths = buildLaunchPaths({
		sessionDir: context.sessionDir,
		sessionId: context.sessionId,
		agentDir: context.agentDir,
		cwd: context.cwd,
		name: request.name,
		id,
	});

	const childArgv = harness.buildArgv({
		bin: binary,
		childSessionFile: paths.childSessionFile,
		childExtensionPath,
		name: request.name,
		model: profile.model,
		thinking: profile.thinking,
		tools,
		taskFile: paths.taskFile,
	});

	const script = buildLaunchScript({
		name: request.name,
		agent: request.agent,
		id,
		cwd: context.cwd,
		piArgv: childArgv,
		envPath: context.env.PATH ?? "",
		env: context.config.env,
		agentDir: context.agentDirOverride,
		childSessionFile: paths.childSessionFile,
		reportFile: paths.reportFile,
		exitCodeFile: paths.exitCodeFile,
		launchPrefix: resolveLaunchPrefix(context.env, context.cwd),
		harness: profile.harness,
	});

	writeLaunchFiles([
		{ path: paths.taskFile, content: buildTaskMarkdown({ body: agent.body, task: request.task, harness: profile.harness }) },
		{ path: paths.scriptFile, content: script },
	]);

	// One source for both layout reads below: the pane this pi is running in is
	// the orchestrator, so it is both the birth split target and the reference
	// rect the 3/5 pass measures against.
	const orchestratorPaneId = currentPaneId(context.env);
	const columns = context.columns;

	// Without a tracker this stays the original call: split right off the
	// orchestrator. With one, the placement decides target and direction.
	const placement = columns && orchestratorPaneId
		? await resolvePlacement(columns, orchestratorPaneId)
		: null;
	const targetPaneId = placement?.targetPaneId ?? orchestratorPaneId;
	const direction = placement?.direction ?? "right";

	let paneId: string;
	try {
		paneId = await herdrPaneOpen({
			cwd: context.cwd,
			targetPaneId,
			direction,
			env: { PI_HERDR_LAUNCH_SCRIPT: paths.scriptFile },
			focus: false,
		});
	} catch (error) {
		return { ok: false, error: `could not open a pane: ${errorMessage(error)}` };
	}

	// The resize pass only runs when the pane is tracked. It reads the layout a
	// second time, because the rects that matter are the ones the split just
	// produced — the first read's geometry is stale the moment the pane opens.
	// Both the read and every resize are best-effort: a failed read means no
	// pass, and a failed resize leaves the pane open and usable.
	if (columns && orchestratorPaneId) {
		await applySpawnResizes(columns, orchestratorPaneId, paneId);
	}

	// Cosmetic: a rename failure must not fail the spawn.
	void herdrPaneRename(paneId, request.name);

	return {
		ok: true,
		warnings,
		running: {
			id,
			name: request.name,
			agent: request.agent,
			profile: { name: profile.name, model: profile.model, thinking: profile.thinking },
			paneId,
			sessionFile: paths.childSessionFile,
			exitCodeFile: paths.exitCodeFile,
			reportFile: paths.reportFile,
			startedAt: Date.now(),
			task: request.task,
		},
	};
}

/** Resolve where a new pane should be placed, using the current layout. */
async function resolvePlacement(
	columns: LiveSubPanes,
	orchestratorPaneId: string,
): Promise<Placement> {
	const layout = await herdrPaneLayout(orchestratorPaneId);
	// A failed read must not prune the tracker, so the empty case skips
	// `liveIn` (which forgets every id the tab does not report) and plans a
	// birth instead.
	const live = layout ? columns.liveIn(layout) : [];
	return planPlacement(layout ?? { tabId: null, panes: [] }, orchestratorPaneId, live);
}

/** Record the pane and apply the initial resize pass. */
async function applySpawnResizes(
	columns: LiveSubPanes,
	orchestratorPaneId: string,
	paneId: string,
): Promise<void> {
	columns.place(paneId);
	const layout = await herdrPaneLayout(orchestratorPaneId);
	if (layout) {
		for (const op of planResizes(layout, orchestratorPaneId, columns.liveIn(layout), paneId)) {
			await herdrPaneResize(op.paneId, op.direction, op.amount);
		}
	}
}

/** `provider/id`, the form `--model` matches against. */
export function parentModelSpec(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/** The session's thinking level, when pi reports one this extension understands. */
export function parentThinking(ctx: ExtensionContext): ThinkingLevel | undefined {
	return isThinkingLevel(ctx.thinkingLevel) ? ctx.thinkingLevel : undefined;
}
