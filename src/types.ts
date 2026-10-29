/**
 * Shared types and constants for tinysubagent.
 */

/**
 * Thinking levels accepted by the child's `--thinking` flag.
 * Declared locally rather than imported from `@earendil-works/pi-agent-core`
 * so this extension resolves against a single package plus the typebox schema
 * library — nothing ambient has to be on the module path at load time.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** agy reasoning effort, the only values its `--effort` flag accepts. */
export type EffortLevel = "low" | "medium" | "high";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

export function isEffortLevel(value: unknown): value is EffortLevel {
	return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The child-side tool that hands a result back to the orchestrator.
 *
 * It lives here rather than in `src/children/child.ts` because
 * `src/children/spawn.ts` must inject the name into the child's `--tools`
 * allowlist, and `spawn.ts` is deliberately free of any pi extension API
 * import — `child.ts` pulls that API
 * in, this file pulls in nothing.
 */
export const REPORT_TOOL_NAME = "subagent_report";

/**
 * Name of the spawn tool, shared with the pi tool, the nesting guard, and the
 * tool-list resolver.
 */
// Renamed from "tinysubagent": the package/config keep the old name, only the
// model-facing tool name changed. It lives here so `src/tool-list.ts` can drop
// it from a floor without importing the spawner that imports the resolver.
export const TOOL_NAME = "subagent";

/** Where an agent definition came from. Project definitions shadow user ones. */
export type AgentSource = "user" | "project";

/** A markdown agent definition: frontmatter metadata plus its prompt body. */
export interface AgentDef {
	name: string;
	description: string;
	/** Raw `tools` entries from frontmatter, before glob expansion. */
	tools?: string[];
	/** Markdown body with frontmatter stripped — the child's system prompt. */
	body: string;
	source: AgentSource;
	path: string;
}

/** Which CLI the child runs on; absent means `pi`. */
export type Harness = "pi" | "agy";

/** A model/thinking profile; thinking is translated for the selected harness. */
export interface Profile {
	model?: string;
	thinking?: ThinkingLevel;
	/** `pi` when absent. Unknown values never reach here: the profile is dropped at load. */
	harness?: Harness;
}
