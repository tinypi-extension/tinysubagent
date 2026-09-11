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
import { ackLine } from "../present/ack.ts";
import {
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
import { TOOL_NAME, parentModelSpec, parentThinking, spawnOne } from "../children/spawn.ts";
import type { SpawnContext, ToolParams } from "../children/contract.ts";
import type { RunningSubagent } from "../children/watcher.ts";
import type { AgentDef } from "../types.ts";
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
	/** Watchers still running, so a shutdown can end them; owned by the caller. */
	watchers: Set<AbortController>;
	/** Reads the caller's shutdown flag, so delivery stops after it. */
	isShuttingDown: () => boolean;
}

export function createTool(deps: ToolDeps): ToolDefinition<TSchema, AckDetails> {
	const { pi, config, parameters, advertisedAgents, capability, columns, watchers, isShuttingDown } = deps;

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

			// Validate every profile before opening any pane, so a bad batch fails
			// whole rather than halfway.
			for (const request of mode.requests) {
				const profile = resolveProfile(config, request.profile, {
					model: parentModelSpec(ctx),
					thinking: parentThinking(ctx),
				});
				if (!profile.ok) return failure(profile.error);
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
			};

			// Launch sequentially: panes are created one at a time anyway, and a
			// partly-failed batch reports exactly which children did start.
			const spawned: SpawnedEntry[] = [];
			const failures: { agent: string; error: string }[] = [];
			const runnings: RunningSubagent[] = [];

			for (const request of mode.requests) {
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

			if (runnings.length > 0) void watchBatch(runnings, { pi, watchers, isShuttingDown, columns });

			const lines = [
				...spawned.map((entry) => ackLine(entry)),
				...failures.map((entry) => `failed ${entry.agent}: ${entry.error}`),
				...spawned.flatMap((entry) => entry.warnings),
			];

			const note = runnings.length === 0 ? NOTE_NOTHING : NOTE_STARTED;

			return {
				content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${note}` }],
				details: {
					status: runnings.length > 0 ? "started" : "error",
					spawned,
					failed: failures,
				},
				isError: runnings.length === 0,
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
				return new Text(theme.fg("error", raw), 0, 0);
			}

			const lines = [
				...spawned.map((entry) => renderAck(entry, theme)),
				...(details?.failed ?? []).map((entry) =>
					theme.fg("error", `failed ${entry.agent}: ${entry.error}`),
				),
				...spawned.flatMap((entry) => entry.warnings.map((warning) => theme.fg("warning", warning))),
				"",
				theme.fg("muted", NOTE_STARTED),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}
