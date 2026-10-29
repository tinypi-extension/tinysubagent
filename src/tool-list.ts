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
	/**
	 * Warning keys this session has already reported. The extension registration
	 * owns one set and hands the same one to every spawn, which is what makes the
	 * registry-dependent warnings below say their piece once. Absent — a
	 * single-shot call such as a test or a smoke run — every warning is emitted,
	 * because there is no session to remember it for.
	 */
	reportedWarnings?: Set<string>;
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
 * Report a registry-dependent, floor-class warning at most once per session.
 *
 * The key names the fact, not the sentence: the same floor entry is the same
 * problem whichever role is spawning, so keying off the message would make the
 * role name part of the identity and repeat it for every role.
 *
 * Role-level warnings deliberately do not go through here. A floor is ambient
 * config that one spawn explains once, but a role's own pattern is that role's
 * mistake: every acknowledgment it affects should name it, or a batch would
 * hide which children need fixing behind whichever child spawned first.
 */
function reportOnce(
	reportedWarnings: Set<string> | undefined,
	key: string,
	message: string,
	warnings: string[],
): void {
	if (reportedWarnings?.has(key)) return;
	reportedWarnings?.add(key);
	warnings.push(message);
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
 *
 * Registry-dependent warnings — an unmatched floor name, the dropped spawn-tool
 * entry, the ignored report-tool negation — go through `reportedWarnings`, so a
 * session explains them once. They describe config that does not change while
 * the session runs, and repeating them would bury the role-level warnings under
 * the same three lines on every acknowledgment. A role's own unmatched patterns
 * are not deduplicated: they name a role, and every acknowledgment they affect
 * should say which role still needs fixing.
 */
export function resolveToolList(input: ToolListInput): ToolList {
	const warnings: string[] = [];

	// Dropping the name is registry-dependent: only a registry that actually
	// offers the spawn tool makes the entry dangerous. Without it the entry is
	// left alone — not dropped, and not called a typo by the check below.
	const floor = input.registry.includes(TOOL_NAME)
		? input.floor.filter((name) => name !== TOOL_NAME)
		: [...input.floor];
	if (floor.length < input.floor.length) {
		reportOnce(
			input.reportedWarnings,
			`defaultTools:${TOOL_NAME}`,
			`tinysubagent: defaultTools entry "${TOOL_NAME}" is ignored because nested delegation is not supported.`,
			warnings,
		);
	}

	// A floor name the registry does not know is kept — dropping it would narrow
	// the child without saying so — and reported, matching the rule for a literal
	// role name. The spawn tool is exempt: it is a name this resolver knows how
	// to handle, so above it was either dropped with its own warning or the
	// registry simply does not offer nesting, and neither is a typo.
	for (const name of floor) {
		if (name === TOOL_NAME || input.registry.includes(name)) continue;
		reportOnce(
			input.reportedWarnings,
			`defaultTools:unknown:${name}`,
			`tinysubagent: defaultTools entry "${name}" matches no known tool — the child may be missing what it needs.`,
			warnings,
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
			// The report contract is the same for every role, so one explanation
			// covers whoever declares the negation next.
			reportOnce(
				input.reportedWarnings,
				`contract:deny:${REPORT_TOOL_NAME}`,
				`agent "${input.role}": -${name} is ignored — the report tool is always allowed.`,
				warnings,
			);
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
