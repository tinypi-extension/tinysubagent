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

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildLaunchPaths,
	buildLaunchScript,
	buildPiArgv,
	buildTaskMarkdown,
	resolveLaunchPrefix,
	resolvePiBin,
	runId,
	writeLaunchFiles,
} from "./launch.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PLUGIN_ID,
	currentPaneId,
	herdrPaneOpen,
	herdrPaneRename,
} from "./herdr.ts";
import { resolveProfile } from "./profiles.ts";
import { expandToolPatterns } from "./tool-patterns.ts";
import { isThinkingLevel, REPORT_TOOL_NAME, type AgentDef, type ThinkingLevel } from "./types.ts";
import type { TinysubagentConfig } from "./config.ts";
import type { RunningSubagent } from "./watcher.ts";

export const MAX_PARALLEL_TASKS = 8;

/** Name of the spawn tool, shared with `index.ts` and used for the nesting guard below. */
// Renamed from "tinysubagent": the package/config keep the old name, only the
// model-facing tool name changed.
export const TOOL_NAME = "subagent";

/** The child hook lives beside this module and is loaded into every child. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const childExtensionPath = join(packageRoot, "src", "child.ts");

/** Plugin the pane is opened through; exported for the smoke harness. */
export const panePluginId = PLUGIN_ID;

export interface TaskInput {
	agent: string;
	task: string;
	name?: string;
	profile?: string;
}

/** Shape of the tool's arguments after schema validation. */
export interface ToolParams {
	agent?: string;
	task?: string;
	name?: string;
	tasks?: TaskInput[];
	cwd?: string;
	profile?: string;
}

export interface SpawnRequest {
	agent: string;
	task: string;
	name: string;
	profile?: string;
}

export interface SpawnContext {
	cwd: string;
	/** Effective agent dir the child runs with (project-local when one exists). */
	agentDir: string;
	/** Set only when the project has its own `.pi/agent`; becomes PI_CODING_AGENT_DIR. */
	agentDirOverride: string | null;
	sessionDir: string;
	sessionId: string;
	env: NodeJS.ProcessEnv;
	allToolNames: string[];
	agents: readonly AgentDef[];
	config: TinysubagentConfig;
	parentModel?: string;
	parentThinking?: ThinkingLevel;
}

export interface Spawned {
	ok: true;
	running: RunningSubagent;
	warnings: string[];
}

export interface SpawnFailed {
	ok: false;
	error: string;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Append `-2`, `-3`, … so two children can never share a label or artifact name. */
export function uniqueName(base: string, used: Set<string>): string {
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/**
 * Validate the argument shape. Exactly one mode is allowed: `agent` + `task`, or
 * `tasks`. Mixing them is a caller error rather than something to silently
 * prefer one way or the other.
 */
export function collectRequests(
	input: ToolParams,
): { ok: true; requests: SpawnRequest[] } | { ok: false; error: string } {
	const tasks = input.tasks;
	const hasSingle = input.agent !== undefined || input.task !== undefined;

	if (Array.isArray(tasks) && tasks.length > 0) {
		if (hasSingle) {
			return { ok: false, error: "pass either `agent` + `task`, or `tasks` — not both." };
		}
		if (tasks.length > MAX_PARALLEL_TASKS) {
			return { ok: false, error: `too many tasks: ${tasks.length} (limit ${MAX_PARALLEL_TASKS}).` };
		}

		const requests: SpawnRequest[] = [];
		const used = new Set<string>();
		for (const [index, item] of tasks.entries()) {
			if (typeof item?.agent !== "string" || typeof item?.task !== "string") {
				return { ok: false, error: `tasks[${index}] needs both "agent" and "task".` };
			}
			const agent = item.agent.trim();
			const task = item.task.trim();
			if (agent === "" || task === "") {
				return { ok: false, error: `tasks[${index}] needs a non-empty "agent" and "task".` };
			}
			requests.push({
				agent,
				task,
				name: uniqueName(item.name?.trim() || agent, used),
				profile: item.profile,
			});
		}
		return { ok: true, requests };
	}

	if (typeof input.agent !== "string" || typeof input.task !== "string") {
		return { ok: false, error: "provide `agent` and `task` for one subagent, or `tasks` for several." };
	}
	const agent = input.agent.trim();
	const task = input.task.trim();
	if (agent === "" || task === "") {
		return { ok: false, error: "`agent` and `task` must both be non-empty." };
	}
	const used = new Set<string>();
	return {
		ok: true,
		requests: [{ agent, task, name: uniqueName(input.name?.trim() || agent, used), profile: input.profile }],
	};
}

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

	// Nested delegation is refused rather than half-supported. A child that can
	// spawn has its own pane closed the moment its turn settles, which would
	// strand any grandchild's result — the result arrives in a session that no
	// longer exists. Failing here says so, instead of losing work quietly later.
	if (tools?.includes(TOOL_NAME)) {
		return {
			ok: false,
			error:
				`agent "${agent.name}" lists \`${TOOL_NAME}\` in its tools, so it could spawn subagents of its own. ` +
				"Nested delegation is not supported yet: the child's pane closes when its own turn settles, " +
				`which would strand its children's results. Remove \`${TOOL_NAME}\` from that role.`,
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

	let paneId: string;
	try {
		paneId = await herdrPaneOpen({
			cwd: context.cwd,
			targetPaneId: currentPaneId(context.env),
			direction: "right",
			env: { PI_HERDR_LAUNCH_SCRIPT: paths.scriptFile },
			focus: false,
		});
	} catch (error) {
		return { ok: false, error: `could not open a pane: ${errorMessage(error)}` };
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

// ────────────────────────────────────────────────────────────────────────────
// Session-derived values
// ────────────────────────────────────────────────────────────────────────────

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

/** A project-local `.pi/agent` shadows the user's agent dir for the child. */
export function resolveProjectAgentDir(cwd: string): string | null {
	const local = join(cwd, ".pi", "agent");
	return existsSync(local) ? local : null;
}

export function resolveCwd(candidate: string | undefined, fallback: string): string {
	const raw = candidate?.trim();
	if (!raw) return fallback;
	return isAbsolute(raw) ? raw : resolvePath(fallback, raw);
}
