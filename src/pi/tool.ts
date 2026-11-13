/**
 * The subagent tool definition: its schema, its blocking execute body, and the
 * TUI rendering of its result.
 *
 * The call returns when the whole batch has finished: every child's report is
 * carried in the one tool result, so nothing is delivered afterwards. A human
 * interrupting the turn relays one Esc into every live child pane — the Batch in
 * flight and any earlier child still open — and ends the wait with a cancelled
 * result. Nothing is closed and no child is killed.
 *
 * Registration itself stays in `index.ts`: this module only builds the object
 * `pi.registerTool` is handed, so the register-or-not guard lives in one place.
 *
 * Every value `execute` and `renderResult` used to close over arrives through
 * `ToolDeps`, which keeps the per-registration state (the watcher set, the
 * column tracker) owned by the caller.
 */

import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { ackLine, skipNotice } from "../present/ack.ts";
import {
	NOTE_ALL_SKIPPED,
	NOTE_NOTHING,
	renderAck,
	type AckDetails,
	type SpawnedEntry,
} from "../present/ack-render.ts";
import { buildResultDetails, buildResultText, emptySummaryText, oneLine } from "../present/result.ts";
import { PROMPT_GUIDELINES, buildToolDescription } from "../present/describe.ts";
import { discoverAgents } from "../config/agents.ts";
import { type TinysubagentConfig } from "../config/config.ts";
import { resolveProfile } from "../config/profiles.ts";
import { collectRequests, resolveCwd, resolveProjectAgentDir } from "../children/requests.ts";
import { errorMessage } from "../children/contract.ts";
import { parentModelSpec, parentThinking, spawnOne } from "../children/spawn.ts";
import type { RunningLabels } from "../children/running-labels.ts";
import { routeProfiles, routingActive, type RouteFn } from "../systemone/route.ts";
import type { SpawnContext, SpawnRequest, ToolParams } from "../children/contract.ts";
import type { RunningSubagent } from "../children/watcher.ts";
import { TOOL_NAME, type AgentDef } from "../types.ts";
import type { LiveSubPanes } from "../herdr/layout.ts";
import type { CapabilityCheck } from "./capability.ts";
import { createInterruptRelay } from "./relay-interrupt.ts";
import { watchBatch } from "./watch-batch.ts";

function failure(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "error", error: message },
		isError: true,
	};
}

/**
 * The coloured form of a finished batch: one block per child, then the pre-flight
 * notices. Built from `ResultDetail`, so it draws exactly what the model reads,
 * with each child's ending coloured by how it ended.
 */
function renderReport(details: AckDetails, theme: Theme): string[] {
	const lines: string[] = [];

	for (const entry of details.results ?? []) {
		if (lines.length > 0) lines.push("");
		// Green for a child that handed work back, red for a failure, yellow for a
		// cancellation — the ending the reader has to act on.
		const color = entry.outcome === "completed" ? "success" : entry.outcome === "failed" ? "error" : "warning";
		lines.push(
			[
				theme.fg("toolTitle", theme.bold(entry.name)),
				theme.fg("muted", "—"),
				theme.fg(color, entry.status),
				theme.fg("muted", entry.elapsed),
			].join(" "),
		);

		const meta = [
			entry.agent ? `agent \`${entry.agent}\`` : null,
			entry.profile ? `profile \`${entry.profile}\`` : null,
			`pane \`${entry.paneId}\``,
		].filter((part): part is string => part !== null);
		lines.push(theme.fg("muted", meta.join(" · ")));

		lines.push(`${theme.fg("muted", "Task:")} ${oneLine(entry.task)}`);

		const summary = entry.summary?.trim() ?? "";
		lines.push(
			summary === ""
				? theme.fg("muted", emptySummaryText({ kind: entry.outcome, via: entry.via }, entry.paneId))
				: entry.outcome === "failed"
					? theme.fg("error", `Error: ${summary}`)
					: summary,
		);
	}

	// What never became a child, after the children that did.
	const notices = [
		...(details.failed ?? []).map((entry) => theme.fg("error", `failed ${entry.agent}: ${entry.error}`)),
		...(details.skipped ?? []).map((label) => theme.fg("muted", skipNotice(label))),
		...(details.warnings ?? []).map((warning) => theme.fg("warning", warning)),
	];
	if (notices.length > 0) lines.push("", ...notices);

	return lines;
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
	/**
	 * The routing seam: when a classifier or SystemOne key is configured,
	 * rewrites each request's profile before the validation loop. Built per
	 * execute from the call's `ExtensionContext` so the transport can reach
	 * `ctx.modelRegistry`; injectable so tests never touch the network.
	 */
	route: (ctx: ExtensionContext) => RouteFn;
}

export function createTool(deps: ToolDeps): ToolDefinition<TSchema, AckDetails> {
	const { pi, config, parameters, advertisedAgents, capability, columns, watchers, runningLabels } = deps;

	return {
		name: TOOL_NAME,
		label: "Subagent",
		description: buildToolDescription(advertisedAgents, config),
		promptSnippet: "Delegate a task to a subagent running in its own herdr pane",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters,

		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionContext) {
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

			// The interrupt relay, armed before the first pane exists so that an abort
			// during routing or the spawn loop still reaches the children an earlier call
			// left live. One Esc per pane, issued without awaiting: the call returns as
			// soon as the relay is sent, and a pane that is gone stays silent.
			const relay = createInterruptRelay();
			const relayPanes = (): void => relay.relayAll(columns.trackedIds());
			signal?.addEventListener("abort", relayPanes, { once: true });
			if (signal?.aborted) relayPanes();

			try {
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
				let context: SpawnContext;
				try {
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
					context = {
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
				} catch (error) {
					releaseAll(accepted);
					throw error;
				}

				// Launch sequentially: panes are created one at a time anyway, and a
				// partly-failed batch reports exactly which children did start.
				const spawned: SpawnedEntry[] = [];
				const failures: { agent: string; error: string }[] = [];
				const runnings: RunningSubagent[] = [];

				try {
					for (const request of accepted) {
						// An abort stops the rest of the batch from launching at all: the
						// `finally` below releases the Labels of the requests that never did,
						// while the children that started keep theirs. This check is what keeps
						// another pane from opening after the human has already interrupted.
						if (signal?.aborted) break;
						// A throw is a spawn refusal like any other, and this loop is the seam
						// that keeps one from taking the batch with it: `spawnOne` can fail after
						// a pane is already open, and letting that escape `execute` would strand
						// the children that did start — their Labels held, their panes open, and
						// no watcher to end their wait.
						try {
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
								// This pane opened *during* the abort, after the fan-out over the
								// tracked ids had already run: it gets its one Esc here, before the
								// next-iteration check stops the rest of the batch.
								if (signal?.aborted) relay.relayOne(result.running.paneId);
							} else {
								failures.push({ agent: request.agent, error: result.error });
							}
						} catch (error) {
							failures.push({ agent: request.agent, error: errorMessage(error) });
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

				// What never became a child, in the order the model reads it. Routing
				// warnings are diagnostic text too: the choice fell back to `current` and
				// the model should know why.
				const warnings = [...spawned.flatMap((entry) => entry.warnings), ...routeWarnings];
				const notices = [
					...failures.map((entry) => `failed ${entry.agent}: ${entry.error}`),
					...skipped.map((label) => skipNotice(label)),
					...warnings,
				];

				// Nothing to wait for: the call already has its whole answer. A skip is an
				// answer, not a failure — the work the orchestrator asked for is already
				// running under that label — so only a batch that refused everything is
				// the plain nothing, and only that sets `isError`.
				if (runnings.length === 0) {
					const skippedOnly = failures.length === 0 && skipped.length > 0;
					const text = [
						...spawned.map((entry) => ackLine(entry)),
						...notices,
						skippedOnly ? NOTE_ALL_SKIPPED : NOTE_NOTHING,
					]
						.filter((part) => part !== "")
						.join("\n");

					return {
						content: [{ type: "text" as const, text }],
						details: {
							status: skippedOnly ? "skipped" : "error",
							spawned,
							failed: failures,
							skipped,
							warnings,
						},
						isError: !skippedOnly,
					};
				}

				// The call blocks here until every child has settled. A human interrupting
				// the turn has already relayed one Esc into every live child pane — the
				// abort listener armed above stays attached through this wait — which ends
				// the waits as `cancelled` and leaves the panes open, so the human can keep
				// driving them. No child is closed on the caller's behalf.
				const results = await watchBatch(runnings, signal, {
					watchers,
					columns,
					// The Label is held for exactly as long as its child is running: a
					// settled child — reported, failed, or gone — frees the name again.
					releaseLabel: (label) => runningLabels.release(label),
				});

				// The batch ran, so its report is content whatever it says: a failed or
				// cancelled child is an ending the orchestrator has to read, not an error
				// of this call.
				return {
					content: [
						{
							type: "text" as const,
							text: [buildResultText(results), ...notices].filter((part) => part !== "").join("\n\n"),
						},
					],
					details: {
						...buildResultDetails(results),
						spawned,
						failed: failures,
						skipped,
						warnings,
					},
				};
			} finally {
				// The call is over: a later abort of this signal must not relay into the
				// panes of the calls that follow it.
				signal?.removeEventListener("abort", relayPanes);
			}
		},

		/**
		 * The colored form of the same acknowledgment. The model-facing text stays
		 * plain, so nothing here affects what the model reads — it is the same parts
		 * with the theme applied.
		 */
		renderResult(result, _options, theme) {
			const details = result.details as AckDetails | undefined;

			// A finished batch: the report is the result, so draw it as one.
			if (details?.status === "finished" && details.results) {
				return new Text(renderReport(details, theme).join("\n"), 0, 0);
			}

			// Only a transcript from before the blocking refactor gets here: once a batch
			// has started, `execute` always returns `status: "finished"` above, so the
			// spawn-line rendering below replays the old acknowledgment — a call that had
			// returned while its children were still running. Note that it reads warnings
			// from `spawned[]`, which is where the old path carried them; the live path
			// reports them on `details.warnings`.
			const spawned = details?.spawned ?? [];

			if (spawned.length === 0) {
				const first = result.content[0];
				const raw = first && first.type === "text" ? first.text : "(no output)";
				// A call that started nothing because every requested Label is already
				// running is an answer, not a failure: the pane keeps that notice
				// readable without colouring it as an error. A real refusal stays red.
				const informational = details?.status === "skipped";
				return new Text(theme.fg(informational ? "muted" : "error", raw), 0, 0);
			}

			const lines = [
				...spawned.map((entry) => renderAck(entry, theme)),
				...(details?.failed ?? []).map((entry) =>
					theme.fg("error", `failed ${entry.agent}: ${entry.error}`),
				),
				...(details?.skipped ?? []).map((label) => theme.fg("muted", skipNotice(label))),
				...spawned.flatMap((entry) => entry.warnings.map((warning) => theme.fg("warning", warning))),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}
