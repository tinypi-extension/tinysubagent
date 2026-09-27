import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CURRENT_PROFILE, type TinysubagentConfig } from "../../src/config/config.ts";
import type { SpawnRequest } from "../../src/children/contract.ts";
import type { AgentDef } from "../../src/types.ts";
import {
	MAX_ROUTE_CANDIDATES,
	type RouteFn,
	type RouteInput,
	buildCriteria,
	createRouteFn,
	profileCandidates,
	routeProfiles,
	routingActive,
} from "../../src/systemone/route.ts";

const SYSTEM_ONE: NonNullable<TinysubagentConfig["systemOne"]> = {
	apiKey: "sk-test-key",
	baseUrl: "https://api.typesafe.ai",
	file: "/tmp/tinysubagent.json",
};

/** A config with routing on and one named profile, bent per test. */
function configWith(overrides: Partial<TinysubagentConfig> = {}): TinysubagentConfig {
	return {
		enableProfiles: true,
		profiles: { light: { model: "m-light", thinking: "low" } },
		env: {},
		systemOne: SYSTEM_ONE,
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

test("createRouteFn maps a null client answer to a null choice", async () => {
	const route = createRouteFn(configWith());
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.deepEqual(outcome, { choice: null });
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

test("createRouteFn swallows a throwing fetch", async () => {
	const route = createRouteFn(configWith(), {
		fetch: (async () => {
			throw new Error("dial failed");
		}) as unknown as typeof globalThis.fetch,
	});
	const outcome = await route({ agent: { name: "worker", description: "d" }, task: "t", criteria: {} });
	assert.deepEqual(outcome, { choice: null });
});

/** No warning may ever carry a credential or the routing endpoint. */
function assertRedacted(warnings: readonly string[]): void {
	for (const warning of warnings) {
		for (const secret of [SYSTEM_ONE.apiKey, SYSTEM_ONE.baseUrl]) {
			assert.equal(warning.includes(secret), false, `warning leaks a secret: ${warning}`);
		}
	}
}
