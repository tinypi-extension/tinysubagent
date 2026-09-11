/**
 * The spawn acknowledgment line.
 *
 * The line is the only thing the orchestrator sees between "I asked for three
 * subagents" and the results arriving, so its shape is pinned here: role, label,
 * profile, and the model/thinking the profile resolved to, in that order.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ackLine, ackParts, roleLabel } from "../../src/present/ack.ts";

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
