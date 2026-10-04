import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	FORGOTTEN,
	MAX_CHECK_MESSAGE,
	REPORT_CHECK_CRITERIA,
	REPORT_CHECK_ROLE,
	checkReport,
	clipMessage,
} from "../../src/children/report-check.ts";
import type { SystemOneConfig } from "../../src/config/config.ts";

const SYSTEM_ONE: SystemOneConfig = {
	apiKey: "sk-report-check-test",
	baseUrl: "http://systemone.test",
	model: "systemone-model",
	file: "/tmp/tinysubagent-systemone-test.json",
};

interface RecordedCall {
	url: string;
	body: Record<string, unknown>;
}

/** Fake fetch that records the call and answers from a fixed body. */
function fakeFetch(
	response: { status: number; body?: string },
	calls: RecordedCall[] = [],
): typeof fetch {
	const fn = async (url: unknown, init?: RequestInit): Promise<Response> => {
		calls.push({
			url: String(url),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			arrayBuffer: async () =>
				new TextEncoder().encode(response.body ?? "").buffer as ArrayBuffer,
		} as unknown as Response;
	};
	return fn as unknown as typeof fetch;
}

/** A well-formed chooser answer picking `choice`. */
function answer(choice: string): string {
	return JSON.stringify({
		answers: {
			profile: {
				type: "choice",
				choice,
				confidence: 0.9,
				probabilities: { [choice]: 0.9 },
			},
		},
	});
}

test("a finished result the model never reported is a reminder", async () => {
	const result = await checkReport("All 12 tables migrated.", SYSTEM_ONE, {
		fetch: fakeFetch({ status: 200, body: answer(FORGOTTEN) }),
	});
	assert.equal(result, true);
});

test("a message that is not finished is left alone", async () => {
	const result = await checkReport(
		"Which migration should I run next?",
		SYSTEM_ONE,
		{ fetch: fakeFetch({ status: 200, body: answer("not-finished") }) },
	);
	assert.equal(result, false);
});

test("a chooser that declines to answer never reminds", async () => {
	const result = await checkReport("Done.", SYSTEM_ONE, {
		fetch: fakeFetch({ status: 200, body: "{}" }),
	});
	assert.equal(result, false);
});

test("an answer this code does not know never reminds", async () => {
	const result = await checkReport("Done.", SYSTEM_ONE, {
		fetch: fakeFetch({ status: 200, body: answer("maybe") }),
	});
	assert.equal(result, false);
});

test("a broken transport never reminds and never throws", async () => {
	const failing = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	assert.equal(await checkReport("Done.", SYSTEM_ONE, { fetch: failing }), false);

	const garbage = fakeFetch({ status: 200, body: "not json" });
	assert.equal(await checkReport("Done.", SYSTEM_ONE, { fetch: garbage }), false);

	const notFound = fakeFetch({ status: 404, body: answer(FORGOTTEN) });
	assert.equal(await checkReport("Done.", SYSTEM_ONE, { fetch: notFound }), false);
});

test("the decision carries the message, the role, and the two verdicts", async () => {
	const calls: RecordedCall[] = [];
	await checkReport("The report is written.", SYSTEM_ONE, {
		fetch: fakeFetch({ status: 200, body: answer(FORGOTTEN) }, calls),
	});

	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.ok(call!.url.includes(SYSTEM_ONE.baseUrl!));
	assert.ok(call!.url.includes("/v1/systemone"));
	const state = call!.body.state as { task: string; role: unknown };
	const questions = call!.body.questions as { profile: { criteria: unknown } };
	assert.equal(state.task, "The report is written.");
	assert.deepEqual(state.role, REPORT_CHECK_ROLE);
	assert.deepEqual(questions.profile.criteria, REPORT_CHECK_CRITERIA);
});

test("a long final message is clipped to the decision payload", async () => {
	const calls: RecordedCall[] = [];
	await checkReport("x".repeat(MAX_CHECK_MESSAGE * 3), SYSTEM_ONE, {
		fetch: fakeFetch({ status: 200, body: answer("not-finished") }, calls),
	});

	const [call] = calls;
	const state = call!.body.state as { task: string };
	assert.equal(state.task.length, MAX_CHECK_MESSAGE);
});

test("clipMessage keeps short messages whole", () => {
	assert.equal(clipMessage("short"), "short");
	assert.equal(clipMessage("x".repeat(MAX_CHECK_MESSAGE)).length, MAX_CHECK_MESSAGE);
	assert.equal(
		clipMessage("x".repeat(MAX_CHECK_MESSAGE + 10)).length,
		MAX_CHECK_MESSAGE,
	);
});
