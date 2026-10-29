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
 *
 * `-*` is the floor opt-out rather than a name. It is returned separately so the
 * caller can drop the floor without ever treating `*` as a tool to subtract:
 * that keeps it out of the unknown-negation warning, and it stays a no-op when
 * there is no floor to drop.
 */
function splitDeclared(declared: readonly string[]): {
	positives: string[];
	negatives: string[];
	dropFloor: boolean;
} {
	const positives: string[] = [];
	const negatives: string[] = [];
	let dropFloor = false;
	for (const entry of declared) {
		if (!entry.startsWith("-")) {
			positives.push(entry);
			continue;
		}
		const name = entry.slice(1);
		// `-*` means "do not inherit the floor", not "subtract the tool named `*`".
		if (name === "*") {
			dropFloor = true;
			continue;
		}
		negatives.push(name);
	}
	return { positives, negatives, dropFloor };
}

/**
 * Whether a role's own declaration puts the spawn tool in its child's allowlist.
 *
 * The nesting guard asks this of the role, never of the composed list: a floor
 * entry naming the spawn tool is dropped (ambient config must not refuse every
 * spawn), while a role naming it is a mistake its author can see and fix.
 *
 * The same grammar as the resolver applies, so a negation wins: `*` covers the
 * spawn tool and therefore refuses, but `*, -subagent` is the documented way to
 * take the breadth without nested delegation and must launch.
 */
export function declaresSpawnTool(
	declared: readonly string[] | undefined,
	registry: readonly string[],
): boolean {
	if (!declared || declared.length === 0) return false;
	const { positives, negatives } = splitDeclared(declared);
	if (negatives.includes(TOOL_NAME)) return false;
	return expandToolPatterns(positives, registry).tools.includes(TOOL_NAME);
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
 *
 * `-*` opts out of the floor for the same reason in the other direction: a role
 * that stays narrow must not grow when the floor does. It only removes the
 * floor, so a role's own positives still expand and compose normally.
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

	const { positives, negatives, dropFloor } = splitDeclared(declared);

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
	// Dropping the floor is this word's whole meaning; the rest of the list still
	// composes, which is what makes `-*, read, grep` exactly read and grep.
	for (const name of [...(dropFloor ? [] : floor), ...expanded.tools]) {
		if (seen.has(name)) continue;
		seen.add(name);
		composed.push(name);
	}

	// Something positive was asked for if the configured floor named anything —
	// even a name the spawn-tool filter removed — or the role's own patterns
	// expanded to a name. Without that, an empty list is "nothing resolved" and
	// must stay no-allowlist: it is a broken pattern, not a deliberate narrowing.
	const askedForTools = input.floor.length > 0 || expanded.tools.length > 0;

	if (composed.length === 0) {
		if (!askedForTools) return { allowlist: false, tools: [], warnings };
		warnings.push(
			`agent "${input.role}": the tool list is empty after negation — only ${REPORT_TOOL_NAME} is allowed.`,
		);
		return { allowlist: true, tools: [REPORT_TOOL_NAME], warnings };
	}

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
