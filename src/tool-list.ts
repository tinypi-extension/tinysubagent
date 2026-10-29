/**
 * Composing the tool allowlist a child launches with.
 *
 * Three inputs decide it: the configured floor (`defaultTools`), whatever the
 * role's `tools` frontmatter declares, and the orchestrator's tool registry.
 * Keeping the composition here — pure, with no filesystem and no pane — is what
 * lets the union and negation rules be tested directly instead of through a
 * spawn.
 *
 * The rules live behind one request/result pair so later additions (the floor
 * opt-out, registry warnings) extend the vocabulary without changing the seam.
 */

import { expandToolPatterns } from "./tool-patterns.ts";
import { REPORT_TOOL_NAME, TOOL_NAME } from "./types.ts";

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
 * Split the role's entries into what it adds and what it subtracts.
 *
 * Negation is spelling, not a tool name: the leading `-` is stripped here so it
 * can never be forwarded to the child, which would read it as a literal name.
 */
function splitDeclared(declared: readonly string[]): { positives: string[]; negatives: string[] } {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const entry of declared) {
		if (!entry.startsWith("-")) {
			positives.push(entry);
			continue;
		}
		const name = entry.slice(1);
		// `-*` means "drop the whole floor", not "subtract the tool named `*`".
		// That rule is a later ticket; leaving the branch here keeps it in one place
		// and stops the entry from being reported as an unknown tool in the meantime.
		if (name === "*") continue;
		negatives.push(name);
	}
	return { positives, negatives };
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
 *
 * A floor entry naming the spawn tool is dropped with a warning: the floor is
 * ambient config written for every role at once, so one `subagent` in it must
 * not refuse every spawn in the project. A role naming it itself still refuses
 * in the spawner, because that is a mistake its author can see and fix.
 *
 * Deny wins regardless of position, so `-write, write` and `write, -write` mean
 * the same thing. A list that positives fill and negations then empty is still
 * an allowlist — of the report tool alone — because falling back to "no
 * allowlist" would widen the child to every tool the role just subtracted.
 */
export function resolveToolList(input: ToolListInput): ToolList {
	const warnings: string[] = [];

	// Dropping the name is registry-dependent: without the spawn tool registered
	// it is just an unknown floor name, which warns on its own account.
	const floor = input.registry.includes(TOOL_NAME)
		? input.floor.filter((name) => name !== TOOL_NAME)
		: [...input.floor];
	if (floor.length < input.floor.length) {
		warnings.push(
			`tinysubagent: defaultTools entry "${TOOL_NAME}" is ignored because nested delegation is not supported.`,
		);
	}

	const declared = input.declared ?? [];
	// Intent is read from the configured floor, not the filtered one: a floor that
	// only names the spawn tool is still a request to narrow.
	const intent = input.declared !== undefined || input.floor.length > 0;

	if (!intent) return { allowlist: false, tools: [], warnings };

	const { positives, negatives } = splitDeclared(declared);

	const expanded = expandToolPatterns(positives, input.registry);
	if (expanded.unmatched.length > 0) {
		warnings.push(
			`agent "${input.role}": unknown tool(s) ${expanded.unmatched.join(", ")} — the child may be missing what it needs.`,
		);
	}

	// The report tool is the hand-back contract, so denying it is ignored rather
	// than honoured; a child without it could never deliver a result.
	const denied = new Set<string>();
	for (const name of negatives) {
		if (name === REPORT_TOOL_NAME) {
			warnings.push(`agent "${input.role}": -${name} is ignored — the report tool is always allowed.`);
			continue;
		}
		denied.add(name);
		if (!input.registry.includes(name)) {
			warnings.push(
				`agent "${input.role}": unknown tool(s) -${name} — negation matched no known tool.`,
			);
		}
	}

	const composed: string[] = [];
	const seen = new Set<string>();
	for (const name of [...floor, ...expanded.tools]) {
		if (seen.has(name)) continue;
		seen.add(name);
		composed.push(name);
	}

	// Nothing to subtract from: every pattern matched nothing (or only negations
	// were declared). That is "nothing resolved", not a narrowed child.
	if (composed.length === 0) return { allowlist: false, tools: [], warnings };

	const tools = composed.filter((name) => !denied.has(name));
	if (tools.length === 0) {
		warnings.push(
			`agent "${input.role}": the tool list is empty after negation — only ${REPORT_TOOL_NAME} is allowed.`,
		);
		return { allowlist: true, tools: [REPORT_TOOL_NAME], warnings };
	}

	if (!tools.includes(REPORT_TOOL_NAME)) tools.push(REPORT_TOOL_NAME);
	return { allowlist: true, tools, warnings };
}
