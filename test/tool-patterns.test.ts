import { strict as assert } from "node:assert";
import { test } from "node:test";

import { expandToolPatterns, toolPatternMatches, unmatchedToolPatterns } from "../src/tool-patterns.ts";

test("a literal pattern matches only itself", () => {
	assert.equal(toolPatternMatches("read", "read"), true);
	assert.equal(toolPatternMatches("read", "write"), false);
	// Anchored: a prefix is not a match.
	assert.equal(toolPatternMatches("read_file", "read"), false);
});

test("* matches any run of characters, including none", () => {
	assert.equal(toolPatternMatches("codegraph_codegraph_callers", "codegraph_*"), true);
	assert.equal(toolPatternMatches("codegraph_", "codegraph_*"), true);
	assert.equal(toolPatternMatches("codegraphx", "codegraph_*"), false);
	assert.equal(toolPatternMatches("mcp__tavily__search", "mcp__*"), true);
});

test("a bare * matches everything", () => {
	assert.equal(toolPatternMatches("anything_at_all", "*"), true);
});

test("regex metacharacters in tool names are literal, not syntax", () => {
	assert.equal(toolPatternMatches("a.b", "a.b"), true);
	assert.equal(toolPatternMatches("axb", "a.b"), false);
	assert.equal(toolPatternMatches("a+b", "a+b"), true);
	assert.equal(toolPatternMatches("aab", "a+b"), false);
	assert.equal(toolPatternMatches("x(y)", "x(y)"), true);
	// A literal name must not be able to smuggle a wildcard in.
	assert.equal(toolPatternMatches("aXb", "a.b"), false);
});

test("* interacts with literal metacharacters correctly", () => {
	assert.equal(toolPatternMatches("codegraph.callers", "codegraph.*"), true);
	assert.equal(toolPatternMatches("codegraphXcallers", "codegraph.*"), false);
});

test("unmatchedToolPatterns reports only the patterns that resolved to nothing", () => {
	const names = ["read", "codegraph_codegraph_files"];
	assert.deepEqual(unmatchedToolPatterns(["read", "codegraph_*", "nope_*"], names), ["nope_*"]);
	assert.deepEqual(unmatchedToolPatterns(["read"], names), []);
});

test("expandToolPatterns keeps literal names even when they match nothing", () => {
	// A renamed tool must surface as a warning and a faithful allowlist,
	// not as a silently narrowed one.
	const { tools, unmatched } = expandToolPatterns(["read", "gone"], ["read"]);
	assert.deepEqual(tools, ["read", "gone"]);
	assert.deepEqual(unmatched, ["gone"]);
});

test("expandToolPatterns expands wildcards to concrete names in registry order", () => {
	const names = ["codegraph_codegraph_callers", "read", "codegraph_codegraph_files"];
	const { tools, unmatched } = expandToolPatterns(["codegraph_*"], names);
	assert.deepEqual(tools, ["codegraph_codegraph_callers", "codegraph_codegraph_files"]);
	assert.deepEqual(unmatched, []);
});

test("expandToolPatterns de-duplicates across overlapping entries, preserving first-seen order", () => {
	const names = ["a_1", "a_2", "b_1"];
	const { tools } = expandToolPatterns(["a_*", "a_1", "b_1", "*"], names);
	assert.deepEqual(tools, ["a_1", "a_2", "b_1"]);
});

test("expandToolPatterns ignores an empty list", () => {
	assert.deepEqual(expandToolPatterns([], ["read"]), { tools: [], unmatched: [] });
});
