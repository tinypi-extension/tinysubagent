import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveToolList, type ToolListInput } from "../src/tool-list.ts";
import { REPORT_TOOL_NAME } from "../src/types.ts";

const REGISTRY = ["read", "bash", "edit", "write", "codegraph_query", "codegraph_search"];

/** A resolve call with the registry and role name filled in, so each case states only its input. */
function resolve(overrides: Partial<ToolListInput>): ReturnType<typeof resolveToolList> {
	return resolveToolList({ floor: [], registry: REGISTRY, role: "worker", ...overrides });
}

test("no declared tools on an empty floor means no allowlist at all", () => {
	// An empty list is not "report tool only" — it is "inherit everything", and
	// inventing an allowlist here would silently narrow the child.
	const resolved = resolve({});
	assert.deepEqual(resolved.tools, []);
	assert.equal(resolved.allowlist, false);
	assert.deepEqual(resolved.warnings, []);
});

test("an empty declared list on an empty floor is still no allowlist", () => {
	const resolved = resolve({ declared: [] });
	assert.equal(resolved.allowlist, false);
	assert.deepEqual(resolved.tools, []);
});

test("the floor reaches a role that declares no tools, with the report tool appended", () => {
	const resolved = resolve({ floor: ["read", "bash", "edit"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", "bash", "edit", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, []);
});

test("a role's positives are added to the floor without duplicates, in first-seen order", () => {
	const resolved = resolve({
		floor: ["read", "bash"],
		declared: ["bash", "edit", "read", "write"],
	});
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", "bash", "edit", "write", REPORT_TOOL_NAME]);
});

test("a role's wildcard entries still expand against the registry", () => {
	const resolved = resolve({ declared: ["codegraph_*"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["codegraph_query", "codegraph_search", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, []);
});

test("a wildcard combined with the floor keeps floor order and adds the matches", () => {
	const resolved = resolve({ floor: ["write"], declared: ["codegraph_*", "read"] });
	assert.deepEqual(resolved.tools, [
		"write",
		"codegraph_query",
		"codegraph_search",
		"read",
		REPORT_TOOL_NAME,
	]);
});

test("a wildcard that matches nothing on an empty floor is not an allowlist", () => {
	// The role declared only a pattern, and nothing matched it. That must not
	// become "report tool only": the role meant "nothing resolved", not "narrow".
	const resolved = resolve({ declared: ["nope_*"] });
	assert.equal(resolved.allowlist, false);
	assert.deepEqual(resolved.tools, []);
});

test("an unmatched role pattern warns with the role's name and the pattern", () => {
	const resolved = resolve({ floor: ["read"], declared: ["gone_*", "read"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, [
		'agent "worker": unknown tool(s) gone_* — the child may be missing what it needs.',
	]);
});

test("the report tool is appended once, wherever it already appears", () => {
	const already = resolve({ declared: ["read", REPORT_TOOL_NAME] });
	assert.deepEqual(already.tools, ["read", REPORT_TOOL_NAME]);
	const inFloor = resolve({ floor: [REPORT_TOOL_NAME, "read"] });
	assert.deepEqual(inFloor.tools, [REPORT_TOOL_NAME, "read"]);
});

test("a floor name the registry does not know is kept as written", () => {
	// A renamed tool should surface in the allowlist rather than silently narrow
	// it; the warning for an unmatched floor name is a later tick's job.
	const resolved = resolve({ floor: ["gone", "read"] });
	assert.deepEqual(resolved.tools, ["gone", "read", REPORT_TOOL_NAME]);
});

// ────────────────────────────────────────────────────────────────────────────
// `-name` negation: subtracting from the floor and from the role's own positives
// ────────────────────────────────────────────────────────────────────────────

test("a role's negation removes a floor name and keeps the remaining order", () => {
	const resolved = resolve({ floor: ["read", "bash", "write"], declared: ["-bash"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", "write", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, []);
});

test("deny wins whatever the order: `-write, write` and `write, -write` agree", () => {
	// Order independence is the whole point of a deny rule. If the resolver kept
	// last-wins semantics instead, one of these two would silently re-add `write`.
	const deniedFirst = resolve({ floor: ["read"], declared: ["-write", "write"] });
	const deniedLast = resolve({ floor: ["read"], declared: ["write", "-write"] });
	assert.equal(deniedFirst.allowlist, true);
	assert.deepEqual(deniedFirst.tools, ["read", REPORT_TOOL_NAME]);
	assert.deepEqual(deniedFirst.tools, deniedLast.tools);
	assert.deepEqual(deniedFirst.warnings, deniedLast.warnings);
});

test("a role negation subtracts a name its wildcard expanded to", () => {
	const resolved = resolve({ declared: ["codegraph_*", "-codegraph_query"] });
	assert.deepEqual(resolved.tools, ["codegraph_search", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, []);
});

test("a negation whose name matches no registry tool warns, and the rest stands", () => {
	const resolved = resolve({ floor: ["read"], declared: ["-gone", "bash"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", "bash", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, [
		'agent "worker": unknown tool(s) -gone — negation matched no known tool.',
	]);
});

test("a list emptied by subtraction still spawns with only the report tool and a warning", () => {
	// Spawning with no allowlist here would widen the child to every tool, which
	// is the opposite of what the role asked for. Report-only plus a warning is
	// the narrow reading, and the warning is the only way the user learns why.
	const resolved = resolve({ floor: ["read", "bash"], declared: ["-read", "-bash"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, [REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, [
		`agent "worker": the tool list is empty after negation — only ${REPORT_TOOL_NAME} is allowed.`,
	]);
});

test("a negation cannot turn an empty expansion into a report-only allowlist", () => {
	// Nothing matched the pattern, so there was never a positive set to subtract
	// from: the role resolved nothing, and that stays "no allowlist", not "narrow".
	const resolved = resolve({ declared: ["nope_*", "-read"] });
	assert.equal(resolved.allowlist, false);
	assert.deepEqual(resolved.tools, []);
	assert.deepEqual(resolved.warnings, [
		'agent "worker": unknown tool(s) nope_* — the child may be missing what it needs.',
	]);
});

test("-subagent_report is ignored with a warning and the report tool is still appended", () => {
	// The report tool is the hand-back contract, not a capability a role can
	// subtract; denying it would leave the child no way to finish.
	const resolved = resolve({ floor: ["read"], declared: ["-subagent_report"] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, [
		'agent "worker": -subagent_report is ignored — the report tool is always allowed.',
	]);
});

test("a negation is not mistaken for a tool name, with or without positives", () => {
	// `-write` must never be forwarded as a literal name: pi would accept it as a
	// tool that does not exist rather than as a subtraction.
	for (const declared of [["-write"], ["read", "-write"]]) {
		const resolved = resolve({ floor: ["read", "write"], declared });
		assert.equal(resolved.tools.some((tool) => tool.startsWith("-")), false, declared.join(","));
	}
});
