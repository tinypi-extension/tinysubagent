/**
 * Tool-list glob matching.
 *
 * Tool lists in agent frontmatter accept `*` wildcards so a role can claim a
 * whole family of tools without naming each one — the motivating case being MCP
 * servers that register many tools under a shared prefix (`codegraph_*`).
 *
 * Only `*` is special. Everything else is matched literally, so tool names
 * containing `.` or `+` need no escaping by the author.
 */

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a tool pattern to an anchored RegExp. `*` matches any run of characters. */
function patternToRegExp(pattern: string): RegExp {
	const source = pattern.split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${source}$`);
}

export function toolPatternMatches(name: string, pattern: string): boolean {
	return patternToRegExp(pattern).test(name);
}

/** Patterns that matched no name in `names`, so a typo is visible instead of silent. */
export function unmatchedToolPatterns(patterns: readonly string[], names: readonly string[]): string[] {
	return patterns.filter((pattern) => !names.some((name) => toolPatternMatches(name, pattern)));
}

export interface ExpandedTools {
	/** Concrete tool names, de-duplicated, in first-seen order. */
	tools: string[];
	/** Declared patterns (or literals) that resolved to nothing. */
	unmatched: string[];
}

/**
 * Expand declared tool entries against the real tool registry.
 *
 * A literal name is always kept — even when it matches nothing — so the child's
 * `--tools` allowlist stays faithful to the definition and a rename shows up as
 * a warning rather than a silently narrowed allowlist. Patterns contribute only
 * the names they actually match.
 */
export function expandToolPatterns(patterns: readonly string[], names: readonly string[]): ExpandedTools {
	const tools: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		if (!pattern.includes("*")) {
			if (!seen.has(pattern)) {
				seen.add(pattern);
				tools.push(pattern);
			}
			if (!names.includes(pattern)) unmatched.push(pattern);
			continue;
		}

		const matched = names.filter((name) => toolPatternMatches(name, pattern));
		if (matched.length === 0) {
			unmatched.push(pattern);
			continue;
		}
		for (const name of matched) {
			if (!seen.has(name)) {
				seen.add(name);
				tools.push(name);
			}
		}
	}

	return { tools, unmatched };
}
