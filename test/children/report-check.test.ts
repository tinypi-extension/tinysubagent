import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { TinysubagentConfig } from "../../src/config/config.ts";
import {
	FORGOTTEN,
	MAX_CHECK_MESSAGE,
	REPORT_CHECK_CRITERIA,
	REPORT_CHECK_INSTRUCTIONS,
	REPORT_CHECK_ROLE,
	checkReport,
	clipMessage,
	createReportDecider,
} from "../../src/children/report-check.ts";
import type {
	ClassifierContext,
	ClassifierModelRef,
	ClassifierRegistry,
	ClassifierResult,
	RouteFn,
	RouteInput,
} from "../../src/systemone/route.ts";

const SYSTEM_ONE: NonNullable<TinysubagentConfig["systemOne"]> = {
	apiKey: "sk-test-key",
	baseUrl: "https://api.typesafe.ai",
	model: "jev-latest",
	file: "/tmp/tinysubagent.json",
};

const CLASSIFIER: NonNullable<TinysubagentConfig["classifier"]> = {
	provider: "openrouter",
	model: "typesafe/jev-latest",
	raw: "openrouter/typesafe/jev-latest",
};

/** A full config fixture: no transport unless the test sets one. */
function config(overrides: Partial<TinysubagentConfig> = {}): TinysubagentConfig {
	return {
		enableProfiles: true,
		profiles: { light: { model: "m-light", thinking: "low" } },
		env: {},
		systemOne: null,
		classifier: null,
		sources: [],
		...overrides,
	};
}

/** A RouteFn that records its inputs and answers with one fixed choice. */
function fakeRoute(choice: string | null): { route: RouteFn; calls: RouteInput[] } {
	const calls: RouteInput[] = [];
	const route: RouteFn = async (input) => {
		calls.push(input);
		return { choice };
	};
	return { route, calls };
}

interface FakeRegistry extends ClassifierRegistry {
	findCalls: { type: string; provider: string; modelId: string }[];
	classifyCalls: { model: ClassifierModelRef; context: ClassifierContext }[];
}

/** A classifier registry that records both calls and answers with a fixed result. */
function fakeRegistry(result: ClassifierResult): FakeRegistry {
	const findCalls: FakeRegistry["findCalls"] = [];
	const classifyCalls: FakeRegistry["classifyCalls"] = [];
	return {
		findCalls,
		classifyCalls,
		findOfType(type, provider, modelId) {
			findCalls.push({ type, provider, modelId });
			return { provider, id: modelId };
		},
		async classify(model, context) {
			classifyCalls.push({ model, context });
			return result;
		},
	};
}

/** A classifier result that answers the report-check question with `choice`. */
function answering(choice: string): ClassifierResult {
	return { stopReason: "stop", answers: { profile: { type: "choice", choice } } };
}

/**
 * Run `body` with a global fetch that records its calls and refuses them, so the
 * legacy SystemOne branch is observable without any network. Returns the URLs hit.
 */
async function recordingFetch(body: () => Promise<void>): Promise<string[]> {
	const urls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown) => {
		urls.push(String(input));
		throw new Error("stubbed: no network in tests");
	}) as typeof fetch;
	try {
		await body();
	} finally {
		globalThis.fetch = original;
	}
	return urls;
}

// ────────────────────────────────────────────────────────────────────────────
// checkReport: the verdict over any RouteFn
// ────────────────────────────────────────────────────────────────────────────

test("a forgotten verdict is true", async () => {
	const { route } = fakeRoute(FORGOTTEN);
	assert.equal(await checkReport("All 12 tables migrated.", route), true);
});

test("the route receives the report-check role, criteria, instructions, and the message as task", async () => {
	const { route, calls } = fakeRoute(FORGOTTEN);
	await checkReport("All 12 tables migrated.", route);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		agent: REPORT_CHECK_ROLE,
		task: "All 12 tables migrated.",
		criteria: REPORT_CHECK_CRITERIA,
		instructions: REPORT_CHECK_INSTRUCTIONS,
	});
});

test("a not-finished verdict is false", async () => {
	const { route } = fakeRoute("not-finished");
	assert.equal(await checkReport("Which migration next?", route), false);
});

test("a null choice is false", async () => {
	const { route } = fakeRoute(null);
	assert.equal(await checkReport("Done.", route), false);
});

test("an unknown choice is false", async () => {
	const { route } = fakeRoute("maybe");
	assert.equal(await checkReport("Done.", route), false);
});

test("a route that rejects is false, not a throw", async () => {
	const route: RouteFn = async () => {
		throw new Error("boom");
	};
	assert.equal(await checkReport("Done.", route), false);
});

test("the task is clipped to the decision payload cap", async () => {
	const long = "x".repeat(MAX_CHECK_MESSAGE + 500);
	const { route, calls } = fakeRoute(FORGOTTEN);
	await checkReport(long, route);
	assert.equal(calls[0]?.task, clipMessage(long));
	assert.ok((calls[0]?.task.length ?? Infinity) <= MAX_CHECK_MESSAGE);
	assert.notEqual(calls[0]?.task, long);
});

test("a message within the cap reaches the route verbatim", async () => {
	const short = "Short and finished.";
	const { route, calls } = fakeRoute(FORGOTTEN);
	await checkReport(short, route);
	assert.equal(calls[0]?.task, short);
});

// ────────────────────────────────────────────────────────────────────────────
// createReportDecider: the transport is chosen from config
// ────────────────────────────────────────────────────────────────────────────

test("a classifier config decides through the registry with the report-check question", async () => {
	const registry = fakeRegistry(answering("forgotten"));
	const decide = createReportDecider(config({ classifier: CLASSIFIER }), registry);
	assert.equal(await decide("All 12 tables migrated."), true);

	assert.deepEqual(registry.findCalls, [
		{ type: "classifier", provider: "openrouter", modelId: "typesafe/jev-latest" },
	]);
	const context = registry.classifyCalls[0]?.context;
	assert.deepEqual(context?.state.role, REPORT_CHECK_ROLE);
	assert.equal(context?.state.task, "All 12 tables migrated.");
	assert.equal(context?.questions.profile.instructions, REPORT_CHECK_INSTRUCTIONS);
	assert.deepEqual(context?.questions.profile.criteria, REPORT_CHECK_CRITERIA);
});

test("a classifier not-finished verdict decides false", async () => {
	const registry = fakeRegistry(answering("not-finished"));
	const decide = createReportDecider(config({ classifier: CLASSIFIER }), registry);
	assert.equal(await decide("Which migration next?"), false);
});

test("the classifier wins when both transports are configured", async () => {
	const registry = fakeRegistry(answering("forgotten"));
	let decided: boolean | undefined;
	const urls = await recordingFetch(async () => {
		const decide = createReportDecider(config({ classifier: CLASSIFIER, systemOne: SYSTEM_ONE }), registry);
		decided = await decide("Done.");
	});
	assert.equal(decided, true);
	assert.equal(registry.classifyCalls.length, 1);
	assert.deepEqual(urls, []);
});

test("a classifier with no usable answer is false: missing answers, wrong kind, or a failed run", async () => {
	const cases: ClassifierResult[] = [
		{ stopReason: "stop" },
		{ stopReason: "stop", answers: {} },
		{ stopReason: "stop", answers: { profile: { type: "text", choice: "forgotten" } } },
		{ stopReason: "error", errorMessage: "boom", answers: { profile: { type: "choice", choice: "forgotten" } } },
	];
	for (const result of cases) {
		const decide = createReportDecider(config({ classifier: CLASSIFIER }), fakeRegistry(result));
		assert.equal(await decide("Done."), false, JSON.stringify(result));
	}
});

test("a classifier that throws is false, not a throw", async () => {
	const registry = fakeRegistry(answering("forgotten"));
	registry.classify = async () => {
		throw new Error("classifier exploded");
	};
	const decide = createReportDecider(config({ classifier: CLASSIFIER }), registry);
	assert.equal(await decide("Done."), false);
});

test("a SystemOne-only config uses the legacy transport and never the registry", async () => {
	const registry = fakeRegistry(answering("forgotten"));
	let decided: boolean | undefined;
	const urls = await recordingFetch(async () => {
		const decide = createReportDecider(config({ systemOne: SYSTEM_ONE }), registry);
		decided = await decide("Done.");
	});
	// The stubbed fetch refuses, so the legacy branch degrades to a non-forgotten verdict.
	assert.equal(decided, false);
	assert.equal(registry.classifyCalls.length, 0);
	assert.equal(urls.length, 1);
	assert.ok(urls[0]?.startsWith(SYSTEM_ONE.baseUrl), `expected a call to ${SYSTEM_ONE.baseUrl}, got ${urls[0]}`);
});

test("with no transport the decider resolves false without throwing or calling out", async () => {
	const registry = fakeRegistry(answering("forgotten"));
	let decided: boolean | undefined;
	const urls = await recordingFetch(async () => {
		const decide = createReportDecider(config(), registry);
		decided = await decide("Done.");
	});
	assert.equal(decided, false);
	assert.equal(registry.classifyCalls.length, 0);
	assert.deepEqual(urls, []);
});
