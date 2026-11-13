/**
 * The spawn acknowledgment line.
 *
 * The line is the only thing the orchestrator sees between "I asked for three
 * subagents" and the results arriving, so its shape is pinned here: role, label,
 * profile, and the model/thinking the profile resolved to, in that order.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ackLine, ackParts, roleLabel, spawnNotice } from "../../src/present/ack.ts";

test("a role reads as a title, however the agent id is punctuated", () => {
	assert.equal(roleLabel("scout"), "Scout");
	assert.equal(roleLabel("worker"), "Worker");
	assert.equal(roleLabel("code-reviewer"), "Code-Reviewer");
	assert.equal(roleLabel("mcp_capability"), "Mcp_Capability");
});

test("the line names the role, the label, the profile, the model and the thinking", () => {
	const line = ackLine({
		agent: "scout",
		name: "scout-mcp-capability-check",
		profile: { name: "current", model: "oc-openai/deepseek-flash", thinking: "medium" },
	});
	assert.equal(line, "Scout (scout-mcp-capability-check) [current] oc-openai/deepseek-flash (medium)");
});

test("parts that were not resolved are left out rather than shown empty", () => {
	// A profile name is always known; a model and a thinking level are not, since
	// the parent may not report either.
	assert.equal(ackLine({ agent: "worker", name: "worker", profile: { name: "current" } }), "Worker (worker) [current]");
	assert.equal(
		ackLine({ agent: "worker", name: "worker", profile: { name: "pro", model: "oc-openai/glm-5.3-flash" } }),
		"Worker (worker) [pro] oc-openai/glm-5.3-flash",
	);
	// No profile at all is only reachable if resolution stops carrying one; the
	// line must still be readable instead of printing `[undefined]`.
	assert.equal(ackLine({ agent: "worker", name: "worker", profile: null }), "Worker (worker)");
});

test("the parts are exposed separately, so a coloured line cannot drift from the plain one", () => {
	assert.deepEqual(
		ackParts({
			agent: "scout",
			name: "finder",
			profile: { name: "light", model: "oc-openai/deepseek-flash", thinking: "low" },
		}),
		{
			role: "Scout",
			name: "finder",
			profile: "light",
			model: "oc-openai/deepseek-flash",
			thinking: "low",
		},
	);
});

// ────────────────────────────────────────────────────────────────────────────
// The spawn notice: what the user sees once the batch has started
// ────────────────────────────────────────────────────────────────────────────

test("a spawned child is announced with its role, label, profile, model and thinking", () => {
	assert.equal(
		spawnNotice([
			{
				agent: "scout",
				name: "finder",
				profile: { name: "current", model: "oc-openai/deepseek-flash", thinking: "medium" },
			},
		]),
		"tinysubagent: spawned Scout (finder) [current] oc-openai/deepseek-flash (medium)",
	);
});

test("a profile the classifier model picked says so, and one the caller picked does not", () => {
	const profile = { name: "light", model: "oc-openai/deepseek-flash", thinking: "low" } as const;
	assert.equal(
		spawnNotice([{ agent: "worker", name: "job", profile, routedByClassifier: true }]),
		"tinysubagent: spawned Worker (job) [light (by classifier model)] oc-openai/deepseek-flash (low)",
	);
	assert.equal(
		spawnNotice([{ agent: "worker", name: "job", profile }]),
		"tinysubagent: spawned Worker (job) [light] oc-openai/deepseek-flash (low)",
	);
});

test("a batch is announced as many lines, one per child", () => {
	assert.equal(
		spawnNotice([
			{ agent: "scout", name: "finder", profile: { name: "light", model: "m-light" } },
			{ agent: "worker", name: "job", profile: null },
		]),
		[
			"tinysubagent: spawned 2 subagents",
			"  Scout (finder) [light] m-light",
			"  Worker (job)",
		].join("\n"),
	);
});

test("nothing spawned is announced as nothing", () => {
	assert.equal(spawnNotice([]), "");
});
