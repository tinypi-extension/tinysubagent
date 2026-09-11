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

/** A model/thinking pair the child can be launched with. */
export interface Profile {
	model?: string;
	thinking?: ThinkingLevel;
}
