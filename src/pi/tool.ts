/**
 * The subagent tool definition: its schema, its execute body, and the TUI
 * rendering of its acknowledgment.
 *
 * Registration itself stays in `index.ts`: this module only builds the object
 * `pi.registerTool` is handed, so the register-or-not guard lives in one place.
 *
 * Every value `execute` and `renderResult` used to close over arrives through
 * `ToolDeps`, which keeps the per-registration state (the watcher set, the
 * column tracker, the shutdown flag) owned by the caller.
 */

import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { ackLine, skipNotice } from "../present/ack.ts";
import {
	NOTE_ALL_SKIPPED,
	NOTE_NOTHING,
	NOTE_STARTED,
	renderAck,
	type AckDetails,
	type SpawnedEntry,
} from "../present/ack-render.ts";
import { PROMPT_GUIDELINES, buildToolDescription } from "../present/describe.ts";
import { discoverAgents } from "../config/agents.ts";
import { type TinysubagentConfig } from "../config/config.ts";
import { resolveProfile } from "../config/profiles.ts";
import { collectRequests, resolveCwd, resolveProjectAgentDir } from "../children/requests.ts";
import { parentModelSpec, parentThinking, spawnOne } from "../children/spawn.ts";
import type { RunningLabels } from "../children/running-labels.ts";
import { routeProfiles, routingActive, type RouteFn } from "../systemone/route.ts";
import type { SpawnContext, SpawnRequest, ToolParams } from "../children/contract.ts";
import type { RunningSubagent } from "../children/watcher.ts";
import { TOOL_NAME, type AgentDef } from "../types.ts";
import type { LiveSubPanes } from "../herdr/layout.ts";
import type { CapabilityCheck } from "./capability.ts";
import { watchBatch } from "./watch-batch.ts";

function failure(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "error", error: message },
		isError: true,
	};
}

/** Everything the tool body needs from the registration that built it. */
export interface ToolDeps {
	/** The api being registered against: the tool list and the watcher both need it. */
	pi: ExtensionAPI;
	/** Frozen at registration, so the schema and the description cannot drift. */
	config: TinysubagentConfig;
	/** The parameter schema the model is offered. */
	parameters: TSchema;
	/** Roles found when the registration ran, advertised in the description. */
	advertisedAgents: readonly AgentDef[];
	/** Cached capability probe for this registration. */
	capability: Pick<CapabilityCheck, "ensureReady">;
	/** The sub panes this registration opened, tracked for the layout planner. */
	columns: LiveSubPanes;
	/**
	 * The Labels this registration's running subagents hold. One instance per
	 * registration is the scope of duplicate prevention: a Label reserved by an
	 * earlier call still blocks a later one, and nothing is claimed across
	 * extension instances.
	 */
	runningLabels: RunningLabels;
	/** Watchers still running, so a shutdown can end them; owned by the caller. */
	watchers: Set<AbortController>;
	/**
	 * Warning keys this registration has already reported. One set per
	 * registration is the session scope: the extension registers once per pi
	 * session, and a reload starts a new registration with a fresh set. Optional
	 * so a caller that never wants deduplication (tests, smoke runs) can omit it.
	 */
	reportedWarnings?: Set<string>;
	/** Reads the caller's shutdown flag, so delivery stops after it. */
	isShuttingDown: () => boolean;
	/**
	 * The routing seam: when a classifier or SystemOne key is configured,
	 * rewrites each request's profile before the validation loop. Built per
	 * execute from the call's `ExtensionContext` so the transport can reach
	 * `ctx.modelRegistry`; injectable so tests never touch the network.
	 */
	route: (ctx: ExtensionContext) => RouteFn;
}

export function createTool(deps: ToolDeps): ToolDefinition<TSchema, AckDetails> {
	const {
		pi,
		config,
		parameters,
		advertisedAgents,
		capability,
		columns,
		watchers,
		runningLabels,
		isShuttingDown,
	} = deps;

	return {
		name: TOOL_NAME,
		label: "Subagent",
		description: buildToolDescription(advertisedAgents, config),
		promptSnippet: "Delegate a task to a subagent running in its own herdr pane",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const params = rawParams as ToolParams;

			const problem = await capability.ensureReady();
			if (problem) return failure(problem);

			const cwd = resolveCwd(params.cwd, ctx.cwd);
			const baseAgentDir = getAgentDir();
			const discovered = discoverAgents(cwd, baseAgentDir);
			if (discovered.agents.length === 0) {
				return failure(
					`no agent definitions found in ${discovered.userDir} or ${discovered.projectDir}. ` +
						"Add a markdown file with `name`, `description` and `tools` frontmatter.",
				);
			}

			const mode = collectRequests(params);
			if (!mode.ok) return failure(mode.error);

			// Claim each request's effective Label before anything else looks at it,
			// so a request that would run a second child under a Label already in use
			// is skipped here — before routing, before a Brief is written, before a
			// pane exists. Claim and check are one synchronous pass, which is what
			// stops two overlapping calls from both passing the check.
			const accepted: SpawnRequest[] = [];
			const skipped: string[] = [];
			const releaseAll = (batch: readonly SpawnRequest[]): void => {
				for (const request of batch) runningLabels.release(request.name);
			};
			for (const request of mode.requests) {
				if (runningLabels.reserve(request.name)) accepted.push(request);
				else skipped.push(request.name);
			}

			// Routing rewrites each request's profile before the validation loop
			// runs. It never fails a spawn: every transport failure, rejection, or
			// incoherent answer lands on `current` inside routeProfiles, and
			// requests whose agent is unknown are skipped there — they are refused
			// by the loop below exactly as before, with no brief sent for a spawn
			// that will not happen.
			const routeWarnings: string[] = [];
			if (routingActive(config)) {
				const hasAutoRoutedRequests = accepted.some(
					(request) => !request.profile?.trim() && discovered.agents.some((agent) => agent.name === request.agent),
				);
				if (config.classifier && hasAutoRoutedRequests) {
					ctx.ui?.notify(
						`tinysubagent: routing profile with classifier model ${config.classifier.raw}.`,
						"info",
					);
				}
				await routeProfiles(accepted, config, {
					route: deps.route(ctx),
					agents: discovered.agents,
					warn: (message) => routeWarnings.push(message),
				});
			}

			// Validate every profile before opening any pane, so a bad batch fails
			// whole rather than halfway.
			for (const request of accepted) {
				const profile = resolveProfile(config, request.profile, {
					model: parentModelSpec(ctx),
					thinking: parentThinking(ctx),
				});
				if (!profile.ok) {
					releaseAll(accepted);
					return failure(profile.error);
				}
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			const projectAgentDir = resolveProjectAgentDir(cwd);
			const context: SpawnContext = {
				cwd,
				agentDir: projectAgentDir ?? baseAgentDir,
				agentDirOverride: projectAgentDir,
				sessionDir: sessionFile ? dirname(sessionFile) : join(baseAgentDir, "sessions"),
				sessionId: ctx.sessionManager.getSessionId(),
				env: process.env,
				allToolNames: pi.getAllTools().map((tool) => (tool as { name: string }).name),
				agents: discovered.agents,
				config,
				parentModel: parentModelSpec(ctx),
				parentThinking: parentThinking(ctx),
				columns,
				reportedWarnings: deps.reportedWarnings,
			};

			// Launch sequentially: panes are created one at a time anyway, and a
			// partly-failed batch reports exactly which children did start.
			const spawned: SpawnedEntry[] = [];
			const failures: { agent: string; error: string }[] = [];
			const runnings: RunningSubagent[] = [];

			try {
				for (const request of accepted) {
					const result = await spawnOne(request, context);
					if (result.ok) {
						runnings.push(result.running);
						spawned.push({
							// `running.agent` is null only for a child that was never launched,
							// which cannot reach here — fall back to the request anyway.
							agent: result.running.agent ?? request.agent,
							name: result.running.name,
							paneId: result.running.paneId,
							profile: result.running.profile,
							warnings: result.warnings,
						});
					} else {
						failures.push({ agent: request.agent, error: result.error });
					}
				}
			} finally {
				// Only a running child keeps its Label. A refused Spawn frees the name at
				// once, so the same request can be retried as it was written.
				const started = new Set(runnings.map((running) => running.name));
				for (const request of accepted) {
					if (!started.has(request.name)) runningLabels.release(request.name);
				}
			}

			if (runnings.length > 0) {
				void watchBatch(runnings, {
					pi,
					watchers,
					isShuttingDown,
					columns,
					// The Label is held for exactly as long as its child is running: a
					// settled child — reported, failed, or gone — frees the name again.
					releaseLabel: (label) => runningLabels.release(label),
				});
			}

			const lines = [
				...spawned.map((entry) => ackLine(entry)),
				...failures.map((entry) => `failed ${entry.agent}: ${entry.error}`),
				...skipped.map((label) => skipNotice(label)),
				// Routing warnings are diagnostic text for the model — the choice
				// fell back to `current` and the model should know why. `renderResult`
				// stays as-is deliberately: it is the same parts with a theme, so
				// plain-text lines the renderer has never been taught about would
				// only lose their meaning in colour.
				...routeWarnings,
			];

			// A skip is an answer, not a failure: nothing was refused, the work the
			// orchestrator asked for is already running under that label. Only a
			// batch that started nothing and refused nothing is the plain nothing.
			const note =
				runnings.length > 0
					? NOTE_STARTED
					: failures.length === 0 && skipped.length > 0
						? NOTE_ALL_SKIPPED
						: NOTE_NOTHING;
			// `skipped` is its own status so a caller can tell "already running"
			// from a refusal without re-reading the text.
			const status = runnings.length > 0 ? "started" : failures.length === 0 && skipped.length > 0 ? "skipped" : "error";

			return {
				content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${note}` }],
				details: {
					status,
					spawned,
					failed: failures,
					skipped,
				},
				isError: runnings.length === 0 && skipped.length === 0,
			};
		},

		/**
		 * The colored form of the same acknowledgment. The model-facing text stays
		 * plain, so nothing here affects what the model reads — it is the same parts
		 * with the theme applied.
		 */
		renderResult(result, _options, theme) {
			const details = result.details as AckDetails | undefined;
			const spawned = details?.spawned ?? [];

			if (spawned.length === 0) {
				const first = result.content[0];
				const raw = first && first.type === "text" ? first.text : "(no output)";
				// A call that started nothing because every requested Label is already
				// running is an answer, not a failure: the pane keeps that notice
				// readable without colouring it as an error. A real refusal stays red.
				const informational = (details?.skipped?.length ?? 0) > 0 && (details?.failed?.length ?? 0) === 0;
				return new Text(theme.fg(informational ? "muted" : "error", raw), 0, 0);
			}

			const lines = [
				...spawned.map((entry) => renderAck(entry, theme)),
				...(details?.failed ?? []).map((entry) =>
					theme.fg("error", `failed ${entry.agent}: ${entry.error}`),
				),
				...(details?.skipped ?? []).map((label) => theme.fg("muted", skipNotice(label))),
				...spawned.flatMap((entry) => entry.warnings.map((warning) => theme.fg("warning", warning))),
				"",
				theme.fg("muted", NOTE_STARTED),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}
