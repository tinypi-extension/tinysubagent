import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ResolvedProfile } from "../../src/config/profiles.ts";
import { buildResultDetails, buildResultText, formatDuration, statusLabel } from "../../src/present/result.ts";
import type { SubagentOutcome } from "../../src/children/watcher.ts";

/** The profile every result is reported under unless a test overrides it. */
const LIGHT: ResolvedProfile = { name: "light", model: "oc-openai/deepseek-flash", thinking: "low" };

function result(
	name: string,
	outcome: SubagentOutcome,
	overrides: { task?: string; profile?: ResolvedProfile | null; paneId?: string; elapsedMs?: number } = {},
) {
	return {
		name,
		agent: "worker",
		profile: overrides.profile === undefined ? LIGHT : overrides.profile,
		paneId: overrides.paneId ?? "w1:p2",
		task: overrides.task ?? `task for ${name}`,
		sessionFile: "/sessions/x.jsonl",
		outcome,
		elapsedMs: overrides.elapsedMs ?? 4_000,
	};
}

const done: SubagentOutcome = { kind: "completed", via: "turn-end", summary: "PONG" };

/** The batch-level note: the second paragraph of the result, above the sections. */
function batchNote(text: string): string | undefined {
	return text.split("\n\n")[1];
}

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
	// A prompt pi refused never started a run: the label has to say that rather
	// than claim an exit code or an error the child never produced.
	assert.equal(
		statusLabel({ kind: "failed", reason: "never-started", exitCode: null, summary: null }),
		"failed (never-started)",
	);
	assert.equal(statusLabel({ kind: "cancelled", summary: null }), "cancelled (pane closed without reporting)");
	// An interrupt is the human stopping the turn, not the pane going away. The
	// label still says which interrupt it was: the operator's own closes the pane it
	// stopped, while a shutdown under the wait leaves it open.
	assert.equal(statusLabel({ kind: "interrupted", cause: "interrupt" }), "interrupted (pane closed)");
	assert.equal(statusLabel({ kind: "interrupted", cause: "shutdown" }), "interrupted (pane left open)");
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

test("an interrupted child is reported as interrupted, with the pane the interrupt left", () => {
	const closed = buildResultText([result("beta", { kind: "interrupted", cause: "interrupt" })]);

	assert.match(closed, /## beta — interrupted \(pane closed\), 4s/);
	assert.match(closed, /no summary: the child was interrupted and its pane was closed/);
	// The interrupt is not a vanished pane, not a missing report and not a failure:
	// the text must not repeat any of those claims. A turn stopped by the human was
	// never going to report, so a "never reported" body would send the reader looking
	// for one.
	assert.equal(closed.includes("cancelled"), false, `an interrupted child was reported as cancelled: ${closed}`);
	assert.equal(closed.includes("left open"), false, `an interrupt that closed the pane claimed it was open: ${closed}`);
	assert.doesNotMatch(closed, /report/i);

	// A shutdown ends the same wait the other way: nothing was relayed, nothing was
	// closed, and the pane outlives the call.
	const shutdown = buildResultText([result("beta", { kind: "interrupted", cause: "shutdown" })]);
	assert.match(shutdown, /## beta — interrupted \(pane left open\), 4s/);
	assert.match(shutdown, /no summary: the child was interrupted and its pane was left open/);
});

test("an all-interrupted batch says so, and that every pane was closed", () => {
	const text = buildResultText([
		result("alpha", { kind: "interrupted", cause: "interrupt" }),
		result("beta", { kind: "interrupted", cause: "interrupt" }),
	]);

	// The batch-level statement belongs to the lead, above the sections: a reader
	// has to learn the batch was stopped before reading child-by-child.
	const [lead, note] = text.split("\n\n");
	assert.equal(lead, "2 subagents finished (0 completed, 2 did not).");
	assert.equal(note, "The batch was interrupted: every child's pane was closed.");
});

test("a partly interrupted batch names whose pane was closed", () => {
	const text = buildResultText([
		result("alpha", { kind: "completed", via: "turn-end", summary: "ALPHA" }),
		result("beta", { kind: "interrupted", cause: "interrupt" }),
		result("gamma", { kind: "cancelled", summary: null }),
	]);

	const [lead, note] = text.split("\n\n");
	assert.equal(lead, "3 subagents finished (1 completed, 2 did not).");
	assert.equal(note, "The batch was interrupted: the interrupted child's pane was closed.");
	// alpha reported and gamma's pane was closed with it, so the note must not claim
	// every pane.
	assert.equal(note?.includes("every child"), false, `a partly interrupted batch claimed every pane: ${note}`);
});

test("a batch interrupted by several children reads as plural, and a shutdown says left open", () => {
	const several = buildResultText([
		result("alpha", { kind: "interrupted", cause: "interrupt" }),
		result("beta", { kind: "interrupted", cause: "interrupt" }),
		result("gamma", { kind: "cancelled", summary: null }),
	]);
	assert.equal(
		batchNote(several),
		"The batch was interrupted: the interrupted children's panes were closed.",
	);

	// The whole batch shares one cause, so a shutdown batch uses the same sentences
	// with the pane left open instead.
	const shutdownAll = buildResultText([
		result("alpha", { kind: "interrupted", cause: "shutdown" }),
		result("beta", { kind: "interrupted", cause: "shutdown" }),
	]);
	assert.equal(batchNote(shutdownAll), "The batch was interrupted: every child's pane was left open.");

	const shutdownOne = buildResultText([
		result("alpha", done),
		result("beta", { kind: "interrupted", cause: "shutdown" }),
	]);
	assert.equal(batchNote(shutdownOne), "The batch was interrupted: the interrupted child's pane was left open.");

	const shutdownSeveral = buildResultText([
		result("alpha", { kind: "interrupted", cause: "shutdown" }),
		result("beta", { kind: "interrupted", cause: "shutdown" }),
		result("gamma", { kind: "cancelled", summary: null }),
	]);
	assert.equal(
		batchNote(shutdownSeveral),
		"The batch was interrupted: the interrupted children's panes were left open.",
	);
});

test("a batch nobody interrupted carries no interrupt note", () => {
	const text = buildResultText([result("alpha", done), result("gamma", { kind: "cancelled", summary: null })]);

	assert.equal(text.includes("batch was interrupted"), false, `an uninterrupted batch claimed an interrupt: ${text}`);
});

test("the structured detail of an interrupted child is the kind, the cause and nothing else", () => {
	const [row] = buildResultDetails([result("beta", { kind: "interrupted", cause: "interrupt" })]).results;

	assert.equal(row?.outcome, "interrupted");
	assert.equal(row?.cause, "interrupt");
	assert.equal(row?.status, "interrupted (pane closed)");
	// No summary, even though the child's session may hold partial text: an
	// interrupted turn handed nothing back.
	assert.equal(row?.summary, null);
	assert.equal(row?.via, undefined);
	assert.equal(row?.reason, undefined);
});

test("a shutdown is the same kind with its own cause and label", () => {
	const [row] = buildResultDetails([result("beta", { kind: "interrupted", cause: "shutdown" })]).results;

	assert.equal(row?.outcome, "interrupted");
	assert.equal(row?.cause, "shutdown");
	assert.equal(row?.status, "interrupted (pane left open)");
	assert.equal(row?.summary, null);
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

	// `ResultDetails` is a real type now, so the fields are checked rather than
	// read off a loose record.
	const results = details.results;
	assert.equal(results.length, 2);

	const [alpha, broken] = results;
	assert.equal(alpha?.name, "alpha");
	assert.equal(alpha?.outcome, "completed");
	assert.equal(alpha?.via, "turn-end");
	assert.equal(alpha?.reason, undefined);
	assert.equal(alpha?.cause, undefined);
	assert.equal(alpha?.paneId, "w1:p2");

	assert.equal(broken?.outcome, "failed");
	assert.equal(broken?.reason, "exit");
	assert.equal(broken?.exitCode, 3);
	assert.equal(broken?.via, undefined);
});
