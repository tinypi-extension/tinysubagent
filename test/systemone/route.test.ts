import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CURRENT_PROFILE, type TinysubagentConfig } from "../../src/config/config.ts";
import type { SpawnRequest } from "../../src/children/contract.ts";
import type { AgentDef } from "../../src/types.ts";
import {
	MAX_ROUTE_CANDIDATES,
	type ClassifierContext,
	type ClassifierModelRef,
	type ClassifierRegistry,
	type ClassifierResult,
	type RouteFn,
	type RouteInput,
	buildCriteria,
	createRouteFn,
	profileCandidates,
	routeProfiles,
	routingActive,
} from "../../src/systemone/route.ts";
import { CHOICE_INSTRUCTIONS } from "../../src/systemone/client.ts";

const SYSTEM_ONE: NonNullable<TinysubagentConfig["systemOne"]> = {
	apiKey: "sk-test-key",
	baseUrl: "https://api.typesafe.ai",
	model: "jev-latest",
	file: "/tmp/tinysubagent.json",
};

/** A config with routing on and one named profile, bent per test. */
function configWith(overrides: Partial<TinysubagentConfig> = {}): TinysubagentConfig {
	return {
		enableProfiles: true,
		profiles: { light: { model: "m-light", thinking: "low" } },
		env: {},
		systemOne: SYSTEM_ONE,
		classifier: null,
		sources: [],
		...overrides,
	};
}

function agent(name: string, description = `the ${name} role`): AgentDef {
	return { name, description, body: "", source: "user", path: `/tmp/${name}.md` };
}

function request(agent: string, task: string, profile?: string): SpawnRequest {
	return { agent, task, name: agent, profile };
}

/** A fake `route` that records its inputs and answers from a map (or always). */
function fakeRoute(
	answers: Record<string, { choice: string | null; confidence?: number }>,
	fallback: { choice: string | null } = { choice: null },
): { route: RouteFn; calls: RouteInput[] } {
	const calls: RouteInput[] = [];
	const route: RouteFn = async (input) => {
		calls.push(input);
		return answers[input.task] ?? fallback;
	};
	return { route, calls };
}

// ────────────────────────────────────────────────────────────────────────────
// routingActive
// ────────────────────────────────────────────────────────────────────────────

test("routing is active with profiles enabled, a key, and a named profile", () => {
	assert.equal(routingActive(configWith()), true);
});

test("routing is inactive without a key, with profiles off, or with no named profiles", () => {
	assert.equal(routingActive(configWith({ systemOne: null })), false);
	assert.equal(routingActive(configWith({ enableProfiles: false })), false);
	assert.equal(routingActive(configWith({ profiles: {} })), false);
});

// ────────────────────────────────────────────────────────────────────────────
// profileCandidates
// ────────────────────────────────────────────────────────────────────────────

test("candidates exclude current, whitespace-only, and untrimmed current keys", () => {
	const config = configWith({
		profiles: {
			light: { model: "m" },
			[CURRENT_PROFILE]: { model: "m" },
			" current ": { model: "m" },
			"   ": { model: "m" },
		},
	});
	assert.deepEqual(profileCandidates(config), ["light"]);
});

test("candidates are capped at the maximum", () => {
	const many: Record<string, { model: string }> = {};
	for (let i = 0; i < 60; i++) many[`p${String(i).padStart(2, "0")}`] = { model: "m" };
	const config = configWith({ profiles: many });
	assert.equal(profileCandidates(config).length, MAX_ROUTE_CANDIDATES);
});

// ────────────────────────────────────────────────────────────────────────────
// buildCriteria
// ────────────────────────────────────────────────────────────────────────────

test("criteria carry each profile's model and thinking and exclude current", () => {
	const config = configWith({
		profiles: {
			light: { model: "m-light", thinking: "low" },
			modelOnly: { model: "m-only" },
			plain: {},
			[CURRENT_PROFILE]: { model: "m" },
		},
	});
	const criteria = buildCriteria(config);
	assert.deepEqual(Object.keys(criteria), ["light", "modelOnly", "plain"]);
	assert.equal(criteria.light, "model m-light, thinking low");
	assert.equal(criteria.modelOnly, "model m-only");
	assert.equal(criteria.plain, "default model and thinking");
	assert.equal(Object.hasOwn(criteria, CURRENT_PROFILE), false);
});

// ────────────────────────────────────────────────────────────────────────────
// routeProfiles
// ────────────────────────────────────────────────────────────────────────────

test("a valid returned name is written to the request's profile", async () => {
	const { route } = fakeRoute({ t1: { choice: "light", confidence: 0.9 } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith(), {
		route,
		agents: [agent("worker", "does work")],
	});
	assert.equal(requests[0]?.profile, "light");
});

test("an unknown name falls back to current with one warning naming it", async () => {
	const warnings: string[] = [];
	const { route } = fakeRoute({ t1: { choice: "nope" } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith(), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /nope/);
	assertRedacted(warnings);
});

test("the name current falls back to current with one warning", async () => {
	const warnings: string[] = [];
	const { route } = fakeRoute({ t1: { choice: CURRENT_PROFILE } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith(), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assertRedacted(warnings);
});

test("a null outcome is silent and leaves current", async () => {
	const warnings: string[] = [];
	const { route } = fakeRoute({ t1: { choice: null } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith(), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	assert.equal(requests[0]?.profile, undefined);
	assert.deepEqual(warnings, []);
});

test("a rejecting route leaves current and the batch continues", async () => {
	const warnings: string[] = [];
	const calls: RouteInput[] = [];
	const route: RouteFn = async (input) => {
		calls.push(input);
		if (input.task === "boom") throw new Error("transport exploded");
		return { choice: "light" };
	};
	const requests = [request("worker", "boom"), request("worker", "fine")];
	await routeProfiles(requests, configWith(), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(requests[1]?.profile, "light");
	assert.equal(calls.length, 2);
	assert.deepEqual(warnings, []);
});

test("an unknown agent name triggers zero route calls and leaves the profile untouched", async () => {
	const { route, calls } = fakeRoute({ t1: { choice: "light" } });
	const requests = [request("nope", "t1", "preset")];
	await routeProfiles(requests, configWith(), { route, agents: [agent("worker")] });
	assert.equal(calls.length, 0);
	assert.equal(requests[0]?.profile, "preset");
});

test("routing off calls route zero times", async () => {
	const { route, calls } = fakeRoute({ t1: { choice: "light" } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith({ enableProfiles: false }), {
		route,
		agents: [agent("worker")],
	});
	await routeProfiles(requests, configWith({ systemOne: null }), { route, agents: [agent("worker")] });
	assert.equal(calls.length, 0);
	assert.equal(requests[0]?.profile, undefined);
});

test("more profiles than the cap warns once from routeProfiles", async () => {
	const warnings: string[] = [];
	const many: Record<string, { model: string }> = {};
	for (let i = 0; i < MAX_ROUTE_CANDIDATES + 1; i++) many[`p${String(i).padStart(2, "0")}`] = { model: "m" };
	const { route, calls } = fakeRoute({ t1: { choice: "p00" } });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, configWith({ profiles: many }), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	assert.equal(warnings.length, 1);
	assert.equal(calls[0]?.criteria && Object.keys(calls[0].criteria).length, MAX_ROUTE_CANDIDATES);
});

// ────────────────────────────────────────────────────────────────────────────
// createRouteFn
// ────────────────────────────────────────────────────────────────────────────

test("createRouteFn turns a failed attempt into one redacted warning and no choice", async () => {
	const route = createRouteFn(configWith(), {
		fetch: (async () =>
			new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.equal(outcome.choice, null);
	assert.match(outcome.warning ?? "", /systemOne routing failed/);
	assert.match(outcome.warning ?? "", /HTTP 401/);
	assert.match(outcome.warning ?? "", /current/);
	assertRedacted([outcome.warning ?? ""]);
});

test("createRouteFn stays silent when the client answers", async () => {
	const route = createRouteFn(configWith(), {
		fetch: (async () =>
			new Response(JSON.stringify({
				answers: { profile: { type: "choice", choice: "light", probabilities: { light: 1 } } },
			}), { status: 200 })) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.equal(outcome.warning, undefined);
	assert.deepEqual(outcome, { choice: "light", confidence: 0 });
});

test("createRouteFn passes the client answer through", async () => {
	const route = createRouteFn(configWith(), {
		fetch: (async () =>
			new Response(JSON.stringify({
				answers: { profile: { type: "choice", choice: "light", probabilities: { light: 1 } } },
			}), { status: 200 })) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.deepEqual(outcome, { choice: "light", confidence: 0 });
});

test("createRouteFn is inert without a key and never throws", async () => {
	const route = createRouteFn(configWith({ systemOne: null }));
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.deepEqual(outcome, { choice: null });
});

test("createRouteFn swallows a throwing fetch into a warning", async () => {
	const route = createRouteFn(configWith(), {
		fetch: (async () => {
			throw new Error(`dial failed at ${SYSTEM_ONE.baseUrl}`);
		}) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.equal(outcome.choice, null);
	assert.match(outcome.warning ?? "", /systemOne routing failed/);
	assert.match(outcome.warning ?? "", /network error/);
	assertRedacted([outcome.warning ?? ""]);
});

test("createRouteFn sends the configured model, not a hardcoded one", async () => {
	let sent: Record<string, unknown> = {};
	const route = createRouteFn(configWith({ systemOne: { ...SYSTEM_ONE, model: "cc/acme/big" } }), {
		fetch: (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					answers: { profile: { type: "choice", choice: "light", probabilities: { light: 1 } } },
				}),
				{ status: 200 },
			);
		}) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.deepEqual(outcome, { choice: "light", confidence: 0 });
	assert.equal(sent.model, "cc/acme/big");
});

// ────────────────────────────────────────────────────────────────────────────
// classifier transport
// ────────────────────────────────────────────────────────────────────────────

const CLASSIFIER: NonNullable<TinysubagentConfig["classifier"]> = {
	provider: "openrouter",
	model: "typesafe/jev-latest",
	raw: "openrouter/typesafe/jev-latest",
};

/** A config carrying only the classifier transport, bent per test. */
function classifierConfig(overrides: Partial<TinysubagentConfig> = {}): TinysubagentConfig {
	return configWith({ systemOne: null, classifier: CLASSIFIER, ...overrides });
}

interface FakeRegistry extends ClassifierRegistry {
	findCalls: { type: string; provider: string; modelId: string }[];
	classifyCalls: {
		model: ClassifierModelRef;
		context: ClassifierContext;
		options?: { signal?: AbortSignal };
	}[];
}

/** A registry that records both calls and answers from an injected implementation. */
function fakeRegistry(
	opts: {
		hit?: boolean;
		classify?: (context: ClassifierContext, options?: { signal?: AbortSignal }) => Promise<ClassifierResult>;
	} = {},
): FakeRegistry {
	const hit = opts.hit ?? true;
	const findCalls: FakeRegistry["findCalls"] = [];
	const classifyCalls: FakeRegistry["classifyCalls"] = [];
	const classifyImpl =
		opts.classify ??
		(async () => ({
			stopReason: "stop",
			answers: { profile: { type: "choice", choice: "light" } },
		}));
	return {
		findCalls,
		classifyCalls,
		findOfType(type, provider, modelId) {
			findCalls.push({ type, provider, modelId });
			return hit ? { provider, id: modelId } : undefined;
		},
		async classify(model, context, options) {
			classifyCalls.push({ model, context, options });
			return classifyImpl(context, options);
		},
	};
}

/** Drive one request through the classifier transport and collect its warnings. */
async function routeWithClassifier(
	registry: ClassifierRegistry,
): Promise<{ requests: SpawnRequest[]; warnings: string[] }> {
	const warnings: string[] = [];
	const route = createRouteFn(classifierConfig(), { registry });
	const requests = [request("worker", "t1")];
	await routeProfiles(requests, classifierConfig(), {
		route,
		agents: [agent("worker")],
		warn: (message) => warnings.push(message),
	});
	return { requests, warnings };
}

test("routing is active with a classifier and no SystemOne key", () => {
	assert.equal(routingActive(classifierConfig()), true);
	assert.equal(routingActive(classifierConfig({ enableProfiles: false })), false);
});

test("a classifier choice lands on the request's profile", async () => {
	const registry = fakeRegistry();
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, "light");
	assert.deepEqual(warnings, []);
});

test("the classifier transport asks for the configured provider and model id", async () => {
	const registry = fakeRegistry();
	await routeWithClassifier(registry);
	assert.deepEqual(registry.findCalls, [
		{ type: "classifier", provider: "openrouter", modelId: "typesafe/jev-latest" },
	]);
});

test("the classify context carries task, role, choice instructions, and criteria", async () => {
	const registry = fakeRegistry();
	await routeWithClassifier(registry);
	const call = registry.classifyCalls[0];
	assert.ok(call);
	assert.equal(call.context.state.task, "t1");
	assert.deepEqual(call.context.state.role, { name: "worker", description: "the worker role" });
	assert.equal(call.context.questions.profile.type, "choice");
	assert.equal(call.context.questions.profile.instructions, CHOICE_INSTRUCTIONS);
	assert.deepEqual(call.context.questions.profile.criteria, buildCriteria(classifierConfig()));
	assert.ok(call.options?.signal);
});

test("a route input with no instructions reaches the classifier as CHOICE_INSTRUCTIONS verbatim", async () => {
	const registry = fakeRegistry();
	const route = createRouteFn(classifierConfig(), { registry });
	await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: { light: "cheap" } });
	const call = registry.classifyCalls[0];
	assert.equal(call?.context.questions.profile.instructions, CHOICE_INSTRUCTIONS);
});

test("caller-supplied instructions reach the classifier verbatim", async () => {
	const registry = fakeRegistry();
	const route = createRouteFn(classifierConfig(), { registry });
	const instructions = "Answer with exactly one of the criterion keys.";
	await route({
		agent: { name: "worker", description: "d" },
		task: "t",
		criteria: { light: "cheap" },
		instructions,
	});
	const call = registry.classifyCalls[0];
	assert.equal(call?.context.questions.profile.instructions, instructions);
});

test("a classifier model the registry cannot find warns `is not available` once", async () => {
	const registry = fakeRegistry({ hit: false });
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(registry.classifyCalls.length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /is not available/);
	assert.match(warnings[0] ?? "", /openrouter\/typesafe\/jev-latest/);
});

test("a classifier that stops with an error warns `failed` once and keeps current", async () => {
	const registry = fakeRegistry({
		classify: async () => ({ stopReason: "error", errorMessage: "boom" }),
	});
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /failed/);
	assert.doesNotMatch(warnings[0] ?? "", /is not available/);
});

test("a classifier that stops as aborted warns `failed` once and keeps current", async () => {
	const registry = fakeRegistry({ classify: async () => ({ stopReason: "aborted" }) });
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /failed/);
});

test("a throwing classify warns `failed` once and never rejects", async () => {
	const registry = fakeRegistry({
		classify: async () => {
			throw new Error("classifier exploded");
		},
	});
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /failed/);
});

test("a missing classifier answer warns `failed` once and keeps current", async () => {
	const registry = fakeRegistry({ classify: async () => ({ stopReason: "stop", answers: {} }) });
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /failed/);
});

test("a non-choice classifier answer warns `failed` once and keeps current", async () => {
	const registry = fakeRegistry({
		classify: async () => ({
			stopReason: "stop",
			answers: { profile: { type: "text", choice: "light" } },
		}),
	});
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /failed/);
});

test("an off-menu classifier label warns the existing unknown-profile text once", async () => {
	const registry = fakeRegistry({
		classify: async () => ({
			stopReason: "stop",
			answers: { profile: { type: "choice", choice: "nope" } },
		}),
	});
	const { requests, warnings } = await routeWithClassifier(registry);
	assert.equal(requests[0]?.profile, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /nope/);
	assert.match(warnings[0] ?? "", /not a configured profile/);
	assert.doesNotMatch(warnings[0] ?? "", /failed/);
});

test("the classifier transport never touches the network", async () => {
	const registry = fakeRegistry();
	// No `fetch` is injected anywhere; the fake registry is the only call path.
	const route = createRouteFn(classifierConfig(), { registry });
	const outcome = await route({
		agent: { name: "worker", description: "d" },
		task: "t",
		criteria: {},
	});
	assert.deepEqual(outcome, { choice: "light", confidence: undefined });
	assert.equal(registry.classifyCalls.length, 1);
});

/** No warning may ever carry a credential or the routing endpoint. */
function assertRedacted(warnings: readonly string[]): void {
	for (const warning of warnings) {
		for (const secret of [SYSTEM_ONE.apiKey, SYSTEM_ONE.baseUrl]) {
			assert.equal(warning.includes(secret), false, `warning leaks a secret: ${warning}`);
		}
	}
}
