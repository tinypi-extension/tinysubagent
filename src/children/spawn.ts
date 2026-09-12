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

import { buildLaunchPaths, buildLaunchScript, buildPiArgv, buildTaskMarkdown, resolveLaunchPrefix, resolvePiBin, runId, writeLaunchFiles } from "./launch.ts";
import { childExtensionPath } from "../paths.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentPaneId, herdrPaneLayout, herdrPaneOpen, herdrPaneRename, herdrPaneResize } from "../herdr/cli.ts";
import { planPlacement, planResizes } from "../herdr/layout.ts";
import { resolveProfile } from "../config/profiles.ts";
import { expandToolPatterns } from "../tool-patterns.ts";
import { isThinkingLevel, REPORT_TOOL_NAME, type ThinkingLevel } from "../types.ts";
import { errorMessage, type SpawnContext, type SpawnFailed, type SpawnRequest, type Spawned } from "./contract.ts";

/** Name of the spawn tool, shared with `index.ts` and used for the nesting guard below. */
// Renamed from "tinysubagent": the package/config keep the old name, only the
// model-facing tool name changed.
export const TOOL_NAME = "subagent";

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

	const warnings: string[] = [];
	let tools: string[] | null = null;
	if (agent.tools && agent.tools.length > 0) {
		const expanded = expandToolPatterns(agent.tools, context.allToolNames);
		tools = expanded.tools;
		if (expanded.unmatched.length > 0) {
			warnings.push(
				`agent "${agent.name}": unknown tool(s) ${expanded.unmatched.join(", ")} — the child may be missing what it needs.`,
			);
		}
	}

	// Nested delegation is refused rather than half-supported. A grandchild's
	// result lands in the subagent's own session, and the batch contract has no
	// way to carry it up: the orchestrator's steer delivers what its direct
	// children report, and the subagent has no report that carries a
	// grandchild's payload. Failing the spawn says so, instead of losing work
	// quietly later.
	if (tools?.includes(TOOL_NAME)) {
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
	// Injected after the nesting guard, so the guard sees exactly what the role
	// declared. The `tools !== null` guard is the load-bearing part: a role with no
	// `tools` frontmatter passes no `--tools` flag at all, and inventing an
	// allowlist here would silently narrow that child to the report tool alone.
	// An empty expansion is also not an allowlist: the role declared patterns that
	// matched nothing, which means "nothing resolved", not "report tool only".
	if (tools !== null && tools.length > 0 && !tools.includes(REPORT_TOOL_NAME)) tools.push(REPORT_TOOL_NAME);

	const id = runId();
	const paths = buildLaunchPaths({
		sessionDir: context.sessionDir,
		sessionId: context.sessionId,
		agentDir: context.agentDir,
		cwd: context.cwd,
		name: request.name,
		id,
	});

	const piArgv = buildPiArgv({
		piBin: resolvePiBin(context.env),
		childSessionFile: paths.childSessionFile,
		childExtensionPath,
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
		piArgv,
		envPath: context.env.PATH ?? "",
		agentDir: context.agentDirOverride,
		childSessionFile: paths.childSessionFile,
		reportFile: paths.reportFile,
		exitCodeFile: paths.exitCodeFile,
		launchPrefix: resolveLaunchPrefix(context.env, context.cwd),
	});

	writeLaunchFiles([
		{ path: paths.taskFile, content: buildTaskMarkdown({ body: agent.body, task: request.task }) },
		{ path: paths.scriptFile, content: script },
	]);

	// One source for both layout reads below: the pane this pi is running in is
	// the orchestrator, so it is both the birth split target and the reference
	// rect the 3/5 pass measures against.
	const orchestratorPaneId = currentPaneId(context.env);
	const columns = context.columns;

	// Without a tracker this stays the original call: split right off the
	// orchestrator. With one, the placement decides target and direction.
	let targetPaneId = orchestratorPaneId;
	let direction: "right" | "down" = "right";
	if (columns && orchestratorPaneId) {
		const layout = await herdrPaneLayout(orchestratorPaneId);
		// A failed read must not prune the tracker, so the empty case skips
		// `liveIn` (which forgets every id the tab does not report) and plans a
		// birth instead.
		const live = layout ? columns.liveIn(layout) : [];
		const placement = planPlacement(layout ?? { tabId: null, panes: [] }, orchestratorPaneId, live);
		targetPaneId = placement.targetPaneId;
		direction = placement.direction;
	}

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
		columns.place(paneId);
		const layout = await herdrPaneLayout(orchestratorPaneId);
		if (layout) {
			for (const op of planResizes(layout, orchestratorPaneId, columns.liveIn(layout), paneId)) {
				await herdrPaneResize(op.paneId, op.direction, op.amount);
			}
		}
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
