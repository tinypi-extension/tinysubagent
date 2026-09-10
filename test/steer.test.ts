import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { SubagentOutcome } from "../src/watcher.ts";
import { buildResultDetails, buildResultText, formatDuration, statusLabel } from "../src/steer.ts";

function result(
	name: string,
	outcome: SubagentOutcome,
	overrides: { task?: string; profile?: string | null; paneId?: string; elapsedMs?: number } = {},
) {
	return {
		name,
		agent: "worker",
		profile: overrides.profile === undefined ? "light (oc-openai/deepseek-flash, low)" : overrides.profile,
		paneId: overrides.paneId ?? "w1:p2",
		task: overrides.task ?? `task for ${name}`,
		sessionFile: "/sessions/x.jsonl",
		outcome,
		elapsedMs: overrides.elapsedMs ?? 4_000,
	};
}

const done: SubagentOutcome = { kind: "completed", via: "turn-end", summary: "PONG" };

test("durations read as seconds, then minutes", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(4_400), "4s");
	assert.equal(formatDuration(59_000), "59s");
	// A whole minute drops the pointless seconds.
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(formatDuration(3_600_000), "1h 0m");
});

test("each ending gets a label that says which kind of ending it was", () => {
	assert.equal(statusLabel({ kind: "completed", via: "turn-end", summary: null }), "completed");
	// A user quitting the child is not the same as the child finishing.
	assert.equal(
		statusLabel({ kind: "completed", via: "session-exit", summary: null }),
		"completed (session exited)",
	);
	assert.equal(
		statusLabel({ kind: "failed", reason: "error", exitCode: null, summary: null }),
		"failed (error)",
	);
	// An interrupt is not a terminal outcome, so `no-output` is the last reason the
	// label has to render — `aborted` no longer reaches here.
	assert.equal(
		statusLabel({ kind: "failed", reason: "no-output", exitCode: null, summary: null }),
		"failed (no-output)",
	);
	assert.equal(
		statusLabel({ kind: "failed", reason: "exit", exitCode: 3, summary: null }),
		"failed (exit 3)",
	);
	assert.equal(statusLabel({ kind: "cancelled", summary: null }), "cancelled (pane closed without reporting)");
});

test("a reported completion says so, so it is not read as a turn-end guess", () => {
	assert.equal(
		statusLabel({ kind: "completed", via: "report", summary: "the reported result" }),
		"completed (reported)",
	);
});

test("a single subagent reports as a plain result", () => {
	const text = buildResultText([result("scout", done)]);
	assert.match(text, /^Subagent `scout` finished\./);
	// One child needs no numbering or roll-up count.
	assert.equal(text.includes("## 1."), false);
	assert.equal(text.includes("1 subagent"), false);
	assert.match(text, /## scout — completed, 4s/);
	assert.match(text, /agent `worker` · profile `light \(oc-openai\/deepseek-flash, low\)` · pane `w1:p2`/);
	assert.match(text, /\*\*Task:\*\* task for scout/);
	assert.match(text, /PONG$/);
});

test("several subagents arrive as one message with a label per task", () => {
	const text = buildResultText([
		result("alpha", { kind: "completed", via: "turn-end", summary: "ALPHA" }),
		result("beta", { kind: "completed", via: "turn-end", summary: "BETA" }),
	]);
	assert.match(text, /^2 subagents finished \(2 completed\)\./);
	assert.match(text, /## 1\. alpha — completed/);
	assert.match(text, /## 2\. beta — completed/);
	// Both answers are present in the same message, each under its own heading.
	assert.ok(text.indexOf("ALPHA") < text.indexOf("BETA"));
	assert.match(text, /\*\*Task:\*\* task for alpha/);
	assert.match(text, /\*\*Task:\*\* task for beta/);
});

test("a partial batch says how many did not finish", () => {
	const text = buildResultText([
		result("alpha", { kind: "completed", via: "turn-end", summary: "ALPHA" }),
		result("broken", {
			kind: "failed",
			reason: "error",
			exitCode: null,
			summary: "401: model is not supported",
		}),
		result("gamma", { kind: "cancelled", summary: null }),
	]);
	assert.match(text, /^3 subagents finished \(1 completed, 2 did not\)\./);
	assert.match(text, /## 2\. broken — failed \(error\)/);
	assert.match(text, /## 3\. gamma — cancelled \(pane closed without reporting\)/);
});

test("a failure shows its error, not as if it were the subagent's own report", () => {
	const text = buildResultText([
		result("broken", { kind: "failed", reason: "error", exitCode: null, summary: "401: nope" }),
	]);
	assert.match(text, /\*\*Error:\*\* 401: nope/);
});

test("a silent result points at the pane rather than showing nothing", () => {
	const text = buildResultText([
		result("quiet", { kind: "failed", reason: "exit", exitCode: 1, summary: "  " }),
	]);
	assert.match(text, /_\(no output captured — inspect pane `w1:p2`\)_/);
});

test("the message never reaches for a heading deeper than the report itself", () => {
	const text = buildResultText([result("a", done), result("b", done)]);
	// `---` fences the individual results so the parent can still read its own
	// transcript structure around them.
	assert.equal(text.split("\n").filter((line) => line === "---").length, 2);
});

test("details carry the machine-readable form of the same batch", () => {
	const details = buildResultDetails([
		result("alpha", { kind: "completed", via: "turn-end", summary: "ALPHA" }),
		result("broken", { kind: "failed", reason: "exit", exitCode: 3, summary: null }),
	]);
	assert.equal(details.status, "finished");

	const results = details.results as Array<Record<string, unknown>>;
	assert.equal(results.length, 2);

	const [alpha, broken] = results;
	assert.equal(alpha?.name, "alpha");
	assert.equal(alpha?.outcome, "completed");
	assert.equal(alpha?.via, "turn-end");
	assert.equal(alpha?.reason, undefined);
	assert.equal(alpha?.paneId, "w1:p2");

	assert.equal(broken?.outcome, "failed");
	assert.equal(broken?.reason, "exit");
	assert.equal(broken?.exitCode, 3);
	assert.equal(broken?.via, undefined);
});
