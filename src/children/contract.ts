/**
 * The spawn vocabulary: the argument shapes the tool accepts, the request the
 * collector produces, and the context and outcome a spawn reports back.
 *
 * These types are read by both `index.ts` (the tool schema) and `spawn.ts` (the
 * recipe), so they live on their own to keep those two from importing each
 * other. `errorMessage` sits here for the same reason: both sides name errors.
 *
 * Keep this module free of implementation imports — types only.
 */

import type { TinysubagentConfig } from "../config/config.ts";
import type { LiveSubPanes } from "../pane-host/index.ts";
import type { AgentDef, ThinkingLevel } from "../types.ts";
import type { RunningSubagent } from "./watcher.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface TaskInput {
	agent: string;
	task: string;
	name?: string;
	profile?: string;
	/** Fork this conversation into the child. Offered only when `canShareContext`. */
	shareContext?: boolean;
}

/** Shape of the tool's arguments after schema validation. */
export interface ToolParams {
	tasks: TaskInput[];
	cwd?: string;
}

export interface SpawnRequest {
	agent: string;
	task: string;
	name: string;
	profile?: string;
	/** Set only when the task asked for the orchestrator's context. */
	shareContext?: boolean;
}

/**
 * The orchestrator's own branch, as a spawn that asked for it needs it. Absent
 * from a `SpawnContext` when this session has no file to fork.
 */
export interface SharedContextSource {
	/** The orchestrator's session file: the fork's `parentSession`. */
	sessionFile: string;
	/** The active branch, oldest first, from `buildContextEntries()`. */
	branch: readonly SessionEntry[];
	/** Session format version, copied into the fork's header. */
	version: number;
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
	/**
	 * The orchestrator's conversation, when a share is possible at all. Null when
	 * `canShareContext` is off or the session has no file (`--no-session`). A flag
	 * that cannot be honoured never reaches a launch with this null: the tool
	 * refuses it by name, per request, before any launch file is written. This
	 * stays null so a direct caller of `spawnOne` still launches a clean child.
	 */
	sharedContext?: SharedContextSource | null;
	/**
	 * Warning keys this pi session has already reported. One set per extension
	 * registration, handed to every spawn, so registry-dependent warnings about
	 * the floor say their piece once rather than on every acknowledgment. When
	 * absent, every warning is emitted — a context with no session behind it has
	 * nothing to remember.
	 */
	reportedWarnings?: Set<string>;
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
