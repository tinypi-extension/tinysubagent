/**
 * Composing the tool allowlist a child launches with.
 *
 * Three inputs decide it: the configured floor (`defaultTools`), whatever the
 * role's `tools` frontmatter declares, and the orchestrator's tool registry.
 * Keeping the composition here — pure, with no filesystem and no pane — is what
 * lets the union rule be tested directly instead of through a spawn.
 *
 * The rules live behind one request/result pair so later additions (role
 * negation, the floor opt-out, registry warnings) extend the vocabulary without
 * changing the seam.
 */

import { expandToolPatterns } from "./tool-patterns.ts";
import { REPORT_TOOL_NAME } from "./types.ts";

export interface ToolListInput {
	/** Plain names from `defaultTools`: what every child starts from. */
	floor: readonly string[];
	/** The role's raw `tools` entries, `undefined` when it declares none. */
	declared?: readonly string[];
	/** Tool names the orchestrator's registry knows, used to expand `*`. */
	registry: readonly string[];
	/** The role's name, so a warning says whose list it is about. */
	role: string;
}

export interface ToolList {
	/**
	 * Whether the child should get an explicit `--tools` allowlist at all.
	 * Without it no flag is passed and the harness's normal set applies. An empty
	 * expansion is not an allowlist: the role declared patterns that matched
	 * nothing, which means "nothing resolved", not "report tool only".
	 */
	allowlist: boolean;
	/** Final names, first-seen order, report tool included when there is an allowlist. */
	tools: string[];
	/** Problems about this role's list, already phrased for the acknowledgment. */
	warnings: string[];
}

/**
 * Resolve the child's tool list.
 *
 * An allowlist exists only when someone asked for one: the role declares
 * `tools`, or the floor is non-empty. A role that does neither keeps today's
 * behaviour exactly — no flag, no invented narrowing.
 *
 * The report tool is part of every explicit allowlist because it is the way a
 * child hands its result back, not a capability a role can be denied.
 */
export function resolveToolList(input: ToolListInput): ToolList {
	const warnings: string[] = [];
	const declared = input.declared ?? [];
	const intent = input.declared !== undefined || input.floor.length > 0;

	if (!intent) return { allowlist: false, tools: [], warnings };

	const expanded = expandToolPatterns(declared, input.registry);
	if (expanded.unmatched.length > 0) {
		warnings.push(
			`agent "${input.role}": unknown tool(s) ${expanded.unmatched.join(", ")} — the child may be missing what it needs.`,
		);
	}

	const tools: string[] = [];
	const seen = new Set<string>();
	for (const name of [...input.floor, ...expanded.tools]) {
		if (seen.has(name)) continue;
		seen.add(name);
		tools.push(name);
	}

	if (tools.length === 0) return { allowlist: false, tools: [], warnings };

	if (!seen.has(REPORT_TOOL_NAME)) tools.push(REPORT_TOOL_NAME);
	return { allowlist: true, tools, warnings };
}
