/**
 * Routing policy on top of the SystemOne transport: which profiles are offered,
 * how the chooser's answer is trusted, and how a batch of spawn requests gets
 * its `profile` rewritten before the ordinary validation loop runs.
 *
 * Routing can only ever change `request.profile` — every failure, rejection, or
 * transport collapse lands on `current`, which is exactly what an unrouted
 * request resolves to. No warning ever names the API key, the base URL, or the
 * routing endpoint; those are credentials and infrastructure, not diagnostics.
 */

import type { SpawnRequest } from "../children/contract.ts";
import { CURRENT_PROFILE, type TinysubagentConfig } from "../config/config.ts";
import { availableProfileNames } from "../config/profiles.ts";
import { routeOnce, type RouteOnceDeps } from "./client.ts";
import type { AgentDef } from "../types.ts";

/** The chooser picks among at most this many profiles. */
export const MAX_ROUTE_CANDIDATES = 50;

export interface RouteInput {
	agent: { name: string; description: string };
	task: string;
	criteria: Record<string, string>;
}

export interface RouteOutcome {
	choice: string | null;
	confidence?: number;
}

export type RouteFn = (input: RouteInput) => Promise<RouteOutcome>;

export interface RouteDeps {
	route: RouteFn;
	agents: readonly AgentDef[];
	warn?: (message: string) => void;
}

/** Routing is on only when profiles are enabled, a key resolved, and there is something to choose. */
export function routingActive(config: TinysubagentConfig): boolean {
	return config.enableProfiles && config.systemOne !== null && profileCandidates(config).length > 0;
}

/** The names routing may choose among: the `current` implicit profile never is one. */
function namedProfileNames(config: TinysubagentConfig): string[] {
	return availableProfileNames(config).filter((name) => {
		const trimmed = name.trim();
		// An untrimmed key cannot round-trip: a decision rendered as ` current `
		// resolves to `current`, which is the one name routing must not choose.
		return trimmed !== "" && trimmed !== CURRENT_PROFILE && trimmed === name;
	});
}

/** The profiles offered to the chooser, capped so the question stays small. Pure; never warns. */
export function profileCandidates(config: TinysubagentConfig): string[] {
	return namedProfileNames(config).slice(0, MAX_ROUTE_CANDIDATES);
}

/** One criterion per candidate, describing what the profile launches with. Preserves candidate order. */
export function buildCriteria(config: TinysubagentConfig): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const name of profileCandidates(config)) {
		const profile = config.profiles[name];
		const parts: string[] = [];
		if (profile?.model) parts.push(`model ${profile.model}`);
		if (profile?.thinking) parts.push(`thinking ${profile.thinking}`);
		criteria[name] = parts.length > 0 ? parts.join(", ") : "default model and thinking";
	}
	return criteria;
}

/**
 * The real `RouteFn`: drives the transport with the resolved credentials and
 * degrades every failure — including a thrown one — to `{ choice: null }`, so
 * a caller never has to handle a rejection.
 */
export function createRouteFn(config: TinysubagentConfig, deps?: RouteOnceDeps): RouteFn {
	return async (input: RouteInput): Promise<RouteOutcome> => {
		const systemOne = config.systemOne;
		if (systemOne === null) return { choice: null };
		try {
			const outcome = await routeOnce(
				{
					apiKey: systemOne.apiKey,
					baseUrl: systemOne.baseUrl,
					model: systemOne.model,
					task: input.task,
					role: input.agent,
					criteria: input.criteria,
				},
				deps,
			);
			return outcome ?? { choice: null };
		} catch {
			// The transport promises not to throw; this backstop makes the promise airtight.
			return { choice: null };
		}
	};
}

const noopWarn = () => {};

/**
 * Rewrite each request's `profile` from routing, concurrently, before spawn
 * validation runs. Only `request.profile` is touched: a request whose agent is
 * not among `deps.agents` is skipped untouched — it will be refused downstream,
 * and no brief may leave the process for a spawn that will not happen. Never
 * throws; never mutates `config`.
 */
export async function routeProfiles(
	requests: readonly SpawnRequest[],
	config: TinysubagentConfig,
	deps: RouteDeps,
): Promise<void> {
	if (!routingActive(config)) return;
	const warn = deps.warn ?? noopWarn;
	// The cap is a real limitation worth surfacing, exactly once per batch.
	if (namedProfileNames(config).length > MAX_ROUTE_CANDIDATES) {
		warn(
			`tinysubagent: more than ${MAX_ROUTE_CANDIDATES} profiles are configured; ` +
				`only the first ${MAX_ROUTE_CANDIDATES} were offered to routing.`,
		);
	}
	const criteria = buildCriteria(config);
	const byName = new Map(deps.agents.map((agent) => [agent.name, agent]));
	const routable: { request: SpawnRequest; agent: AgentDef }[] = [];
	for (const request of requests) {
		const agent = byName.get(request.agent);
		if (!agent) continue;
		routable.push({ request, agent });
	}

	const outcomes = await Promise.all(
		routable.map(async ({ request, agent }) => {
			try {
				return await deps.route({
					agent: { name: agent.name, description: agent.description },
					task: request.task,
					criteria,
				});
			} catch {
				// One broken call must not stop the batch; a transport failure is silent.
				return null;
			}
		}),
	);

	outcomes.forEach((outcome, index) => {
		const { request } = routable[index]!;
		const choice = outcome === null ? null : outcome.choice;
		if (
			typeof choice === "string" &&
			choice !== CURRENT_PROFILE &&
			Object.hasOwn(config.profiles, choice)
		) {
			request.profile = choice;
			return;
		}
		request.profile = undefined;
		if (typeof choice === "string" && choice !== "") {
			// A rejected *string* answer is diagnosable; a null answer is not.
			const reason =
				choice === CURRENT_PROFILE
					? `tinysubagent: routing declined to choose for "${request.name}"; keeping the current profile.`
					: `tinysubagent: routing chose "${choice}" for "${request.name}", which is not a ` +
						`configured profile; keeping the current profile.`;
			warn(reason);
		}
	});
}
