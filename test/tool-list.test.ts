import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveToolList, type ToolListInput } from "../src/tool-list.ts";
import { REPORT_TOOL_NAME, TOOL_NAME } from "../src/types.ts";

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

test("a floor entry naming the spawn tool is dropped with a warning", () => {
	// The floor is ambient config written once for every role, so one `subagent`
	// entry in it must not refuse every spawn in the project.
	const resolved = resolve({ floor: ["read", TOOL_NAME, "bash"], registry: [...REGISTRY, TOOL_NAME] });
	assert.equal(resolved.allowlist, true);
	assert.deepEqual(resolved.tools, ["read", "bash", REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, [
		`tinysubagent: defaultTools entry "${TOOL_NAME}" is ignored because nested delegation is not supported.`,
	]);
});

test("the spawn-tool drop is the floor's alone: a role that declares it keeps it", () => {
	// The nesting refusal keys off what the role declared, so the resolver must
	// not hide that from the guard by dropping the name everywhere.
	const resolved = resolve({ floor: ["read"], declared: [TOOL_NAME], registry: [...REGISTRY, TOOL_NAME] });
	assert.deepEqual(resolved.tools, ["read", TOOL_NAME, REPORT_TOOL_NAME]);
});

test("a floor entry naming the spawn tool is kept when the registry does not know it", () => {
	// Dropping it is registry-dependent: without the tool registered the entry is
	// just an unknown floor name, which warns on its own account.
	const resolved = resolve({ floor: ["read", TOOL_NAME] });
	assert.deepEqual(resolved.tools, ["read", TOOL_NAME, REPORT_TOOL_NAME]);
	assert.deepEqual(resolved.warnings, []);
});
