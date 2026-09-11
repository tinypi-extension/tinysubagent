/**
 * The spawn vocabulary: the argument shapes the tool accepts, the request the
 * collector produces, and the context and outcome a spawn reports back.
 *
 * These types are read by both `index.ts` (the tool schema) and `spawn.ts` (the
 * recipe), so they live on their own to keep those two from importing each
 * other. `errorMessage` sits here for the same reason: both sides name errors.
 *
 * Keep this module free of implementation imports — types only. In particular
 * `errorMessage` is deliberately a separate implementation from `preflight.ts`'s
 * `errorText`; the two are not to be unified.
 */

import type { TinysubagentConfig } from "../config/config.ts";
import type { LiveSubPanes } from "../herdr/layout.ts";
import type { AgentDef, ThinkingLevel } from "../types.ts";
import type { RunningSubagent } from "./watcher.ts";

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
	/**
	 * Live sub panes this extension instance opened. When absent, spawning keeps
	 * the original behaviour: every child splits right off the orchestrator pane.
	 */
	columns?: LiveSubPanes;
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
