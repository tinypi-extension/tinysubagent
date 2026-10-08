/**
 * Routing policy on top of the SystemOne transport: which profiles are offered,
 * how the chooser's answer is trusted, and how a batch of spawn requests gets
 * its `profile` rewritten before the ordinary validation loop runs.
 *
 * Routing can only ever change `request.profile` — every failure, rejection, or
 * transport collapse lands on `current`, which is exactly what an unrouted
 * request resolves to. A SystemOne failure still speaks: one warning per
 * request carrying the transport's fixed, redacted reason. No warning ever
 * names the API key, the base URL, or the routing endpoint; those are
 * credentials and infrastructure, not diagnostics.
 */

import type { SpawnRequest } from "../children/contract.ts";
import { CURRENT_PROFILE, type TinysubagentConfig } from "../config/config.ts";
import { availableProfileNames } from "../config/profiles.ts";
import { CHOICE_INSTRUCTIONS, SYSTEMONE_TIMEOUT_MS, routeOnce, type RouteOnceDeps } from "./client.ts";
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
	/**
	 * A transport-level diagnosis attached to a `choice: null` failure, emitted by
	 * {@link routeProfiles} as the request's one warning. The spec's literal
	 * `{ choice: null }` cannot distinguish its failure texts (classifier "is not
	 * available" vs "failed", SystemOne's reason); this optional field carries the
	 * difference. It is only ever set when `choice` is null, so a request can never
	 * warn twice.
	 */
	warning?: string;
}

export type RouteFn = (input: RouteInput) => Promise<RouteOutcome>;

/**
 * Minimal structural mirror of pi's ModelRegistry.classify surface. The repo's
 * pinned devDependency is pi-coding-agent@0.85.1, whose types have no
 * `findOfType`/`classify` (the runtime is pi >= 1.1.0), so we declare the shape
 * locally and let the `index.ts` seam cast the real registry into it.
 */
export interface ClassifierModelRef {
	provider?: string;
	id?: string;
}

export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierContext {
	state: { task: string; role: { name: string; description: string } };
	questions: { profile: ClassifierChoiceQuestion };
}

export interface ClassifierChoiceAnswer {
	type: string;
	choice?: string;
	confidence?: number;
}

export interface ClassifierResult {
	answers?: Record<string, ClassifierChoiceAnswer>;
	stopReason?: string;
	errorMessage?: string;
}

export interface ClassifierRegistry {
	findOfType(
		type: "classifier",
		provider: string,
		modelId: string,
	): ClassifierModelRef | undefined;
	classify(
		model: ClassifierModelRef,
		context: ClassifierContext,
		options?: { signal?: AbortSignal },
	): Promise<ClassifierResult>;
}

export interface RouteDeps {
	route: RouteFn;
	agents: readonly AgentDef[];
	warn?: (message: string) => void;
}

/** Routing is on only when profiles are enabled, either transport resolved, and there is something to choose. */
export function routingActive(config: TinysubagentConfig): boolean {
	return (
		config.enableProfiles &&
		(config.classifier !== null || config.systemOne !== null) &&
		profileCandidates(config).length > 0
	);
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

export interface CreateRouteFnDeps extends RouteOnceDeps {
	/** The pi registry that resolves and runs the configured classifier model. */
	registry?: ClassifierRegistry;
}

/** The in-process classifier transport; every failure degrades to one warning. */
function classifierRouteFn(
	classifier: NonNullable<TinysubagentConfig["classifier"]>,
	deps?: CreateRouteFnDeps,
): RouteFn {
	return async (input: RouteInput): Promise<RouteOutcome> => {
		const { provider, model: modelId, raw } = classifier;
		const registry = deps?.registry;
		const model = registry?.findOfType("classifier", provider, modelId);
		if (!registry || !model) {
			// In-process and credential-free: the raw reference is the whole diagnosis.
			return {
				choice: null,
				warning:
					`tinysubagent: classifier model "${raw}" is not available; ` +
					`keeping "${CURRENT_PROFILE}".`,
			};
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SYSTEMONE_TIMEOUT_MS);
		const failed: RouteOutcome = {
			choice: null,
			warning:
				`tinysubagent: classifier model "${raw}" failed; ` + `keeping "${CURRENT_PROFILE}".`,
		};
		try {
			const result = await registry.classify(
				model,
				{
					state: { task: input.task, role: input.agent },
					questions: {
						profile: {
							type: "choice",
							instructions: CHOICE_INSTRUCTIONS,
							criteria: input.criteria,
						},
					},
				},
				{ signal: controller.signal },
			);
			const answer = result.answers?.profile;
			if (result.stopReason === "stop" && !result.errorMessage) {
				if (answer?.type === "choice" && typeof answer.choice === "string") {
					// Off-menu labels are returned as-is; `routeProfiles` owns the warning.
					return { choice: answer.choice, confidence: answer.confidence };
				}
			}
			return failed;
		} catch {
			// Timeout, abort, a throwing classify: keep `current`, say why once.
			return failed;
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * The real `RouteFn`: drives the configured transport and degrades every failure
 * — including a thrown one — to a value a caller never has to handle as a rejection.
 */
export function createRouteFn(config: TinysubagentConfig, deps?: CreateRouteFnDeps): RouteFn {
	// The classifier transport is selected by config, never as a fallback.
	if (config.classifier !== null) return classifierRouteFn(config.classifier, deps);
	return async (input: RouteInput): Promise<RouteOutcome> => {
		const systemOne = config.systemOne;
		// No transport resolved: routing is off, and off is silent.
		if (systemOne === null) return { choice: null };
		// The transport reports *why* it produced nothing; this turns that into the
		// request's one warning. A success warns about nothing.
		let reason: string | undefined;
		const failed = (): RouteOutcome => ({
			choice: null,
			warning:
				`tinysubagent: systemOne routing failed` +
				(reason === undefined ? "" : ` (${reason})`) +
				`; keeping "${CURRENT_PROFILE}".`,
		});
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
				{
					...deps,
					onFailure: (why) => {
						reason = why;
						deps?.onFailure?.(why);
					},
				},
			);
			return outcome ?? failed();
		} catch {
			// The transport promises not to throw; this backstop makes the promise airtight.
			return failed();
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
		// A transport-supplied warning fires for this request exactly once. The
		// classifier sets it only when `choice` is null, and the branch below only
		// warns on a non-empty string choice, so the two can never both fire.
		const warning = outcome?.warning;
		if (typeof warning === "string" && warning !== "") warn(warning);
		const choice = outcome?.choice ?? null;
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
