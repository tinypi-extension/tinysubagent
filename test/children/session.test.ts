import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	findFailureNote,
	findFinalMessage,
	parseSessionEntries,
	readFailureNote,
	readFinalMessage,
} from "../../src/children/session.ts";

test("a partial trailing line is skipped rather than failing the read", () => {
	// Sessions are appended to live, so the last line can be half-written. Losing
	// the whole file to one torn line would lose the answer.
	const raw = [
		'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
		'{"type":"message","message":{"role":"assis',
	].join("\n");
	const entries = parseSessionEntries(raw);
	assert.equal(entries.length, 1);
	assert.equal(findFinalMessage(entries), "hi");
});

test("blank lines and non-JSON noise are tolerated", () => {
	assert.deepEqual(parseSessionEntries("\n\n  \n"), []);
	assert.deepEqual(parseSessionEntries("not json at all"), []);
	assert.equal(parseSessionEntries('{"type":"session"}').length, 1);
});

test("the last assistant text wins, and tool-only messages are skipped", () => {
	const entries = parseSessionEntries(
		[
			'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"do it"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"starting"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"read"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"finished"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"write"}]}}',
		].join("\n"),
	);
	// A run that ends on a tool call still reports the sentence it wrote last.
	assert.equal(findFinalMessage(entries), "finished");
});

test("user messages are never mistaken for the result", () => {
	const entries = parseSessionEntries(
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"the task"}]}}',
	);
	assert.equal(findFinalMessage(entries), null);
});

test("an empty or missing session file yields no summary, not a throw", () => {
	assert.equal(readFinalMessage("/definitely/not/a/session.jsonl"), null);
});

test("a failure note comes from errorMessage, since an errored turn has no text", () => {
	const entries = parseSessionEntries(
		[
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}',
			'{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"401: model is not supported"}}',
		].join("\n"),
	);
	assert.equal(findFinalMessage(entries), "working");
	assert.equal(findFailureNote(entries), "401: model is not supported");
});

test("no error message means no note", () => {
	const entries = parseSessionEntries(
		'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
	);
	assert.equal(findFailureNote(entries), null);
	assert.equal(findFailureNote([]), null);
	assert.equal(readFailureNote("/definitely/not/a/session.jsonl"), null);
});

test("a blank error message is not a note", () => {
	const entries = parseSessionEntries(
		'{"type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"   "}}',
	);
	assert.equal(findFailureNote(entries), null);
});
