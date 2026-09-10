/**
 * tinysubagent — delegate work to subagents running in herdr panes.
 *
 * A spawn is fire-and-forget: the tool opens one pane per task and returns an
 * acknowledgement, then a detached watcher collects each child's final assistant
 * message and delivers it back to this session as a steer message. For a batch,
 * every child's result arrives together in one labelled message.
 *
 * The tool is only registered when this pi is itself running inside herdr. That
 * is a deliberate choice over registering-and-failing: outside herdr there is no
 * pane to split, so offering the tool would only invite calls that cannot work.
 *
 * Only three things leave the orchestrator's process: the launch script it
 * writes, the `herdr plugin pane open` call that runs it, and the poll that
 * notices when the child is done. Everything else is a file on disk.
 */

import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { discoverAgents } from "./src/agents.ts";
import { CURRENT_PROFILE, loadConfig, type TinysubagentConfig } from "./src/config.ts";
import { MIN_HERDR_VERSION, PLUGIN_ID, herdrPaneClose, herdrPaneOpen, herdrPluginInfo, herdrStatus, isInsideHerdr, versionAtLeast } from "./src/herdr.ts";
import { availableProfileNames, profileParamDescription, resolveProfile } from "./src/profiles.ts";
import {
	MAX_PARALLEL_TASKS,
	TOOL_NAME,
	collectRequests,
	parentModelSpec,
	parentThinking,
	resolveCwd,
	resolveProjectAgentDir,
	spawnOne,
	type SpawnContext,
	type ToolParams,
} from "./src/spawn.ts";
import { buildResultDetails, buildResultText, type SubagentResult } from "./src/steer.ts";
import type { AgentDef } from "./src/types.ts";
import { waitForSubagent, type RunningSubagent } from "./src/watcher.ts";

const MAX_LISTED_AGENTS = 12;
const MAX_ADVERTISED_DESCRIPTION = 120;

// ────────────────────────────────────────────────────────────────────────────
// Capability
// ────────────────────────────────────────────────────────────────────────────

let capabilityCheck: Promise<string | null> | null = null;

async function checkHerdr(): Promise<string | null> {
	const status = await herdrStatus();
	if (!status?.running) {
		return "herdr is not reachable from this pane — is the herdr server still running?";
	}
	if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
		return `herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes (found ${status.version ?? "unknown"}). Update herdr and restart its session.`;
	}
	const plugin = await herdrPluginInfo(PLUGIN_ID);
	if (!plugin) {
		return `the herdr plugin "${PLUGIN_ID}" is not installed. Run \`herdr plugin list\` and link it with \`herdr plugin link <dir> --enabled\`.`;
	}
	if (!plugin.enabled) {
		return `the herdr plugin "${PLUGIN_ID}" is disabled. Run: herdr plugin enable ${PLUGIN_ID}`;
	}
	return null;
}

/**
 * Cached capability probe. A failure is not cached, so fixing herdr in place
 * (linking or enabling the plugin) is picked up by the next call without a
 * reload.
 */
async function ensureHerdrReady(): Promise<string | null> {
	capabilityCheck ??= checkHerdr();
	const problem = await capabilityCheck;
	if (problem) capabilityCheck = null;
	return problem;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool surface
// ────────────────────────────────────────────────────────────────────────────

function advertiseAgents(agents: readonly AgentDef[]): string[] {
	const listed = agents.slice(0, MAX_LISTED_AGENTS);
	const lines = listed.map((agent) => {
		const description = agent.description.trim();
		const clipped =
			description.length <= MAX_ADVERTISED_DESCRIPTION
				? description
				: `${description.slice(0, MAX_ADVERTISED_DESCRIPTION - 1)}…`;
		return `- \`${agent.name}\`${clipped ? ` — ${clipped}` : ""}`;
	});
	const remaining = agents.length - listed.length;
	if (remaining > 0) lines.push(`- …and ${remaining} more.`);
	return lines;
}

function buildToolDescription(agents: readonly AgentDef[], config: TinysubagentConfig): string {
	const lines = [
		"Delegate tasks to subagents, each running in its own herdr pane with an isolated context window.",
		"",
		"This returns as soon as the panes are open. Each subagent's result is delivered back to this session automatically as a steer message when it finishes — never wait, poll, sleep, or tail logs for it. Continue with other work, or end your turn.",
		"",
		`Modes: single (\`agent\` + \`task\`) or parallel (\`tasks\` array, up to ${MAX_PARALLEL_TASKS}). Parallel subagents run concurrently and report back together in a single message.`,
		"",
		"Available roles:",
	];

	if (agents.length === 0) {
		lines.push("- (none found)");
	} else {
		lines.push(...advertiseAgents(agents));
	}

	if (config.enableProfiles) {
		lines.push(
			"",
			`Profiles: ${availableProfileNames(config)
				.map((name) => `\`${name}\``)
				.join(", ")}. \`${CURRENT_PROFILE}\` is the default and runs on this session's model and thinking level.`,
		);
	}

	return lines.join("\n");
}

const PROMPT_GUIDELINES = [
	"Use subagent to delegate self-contained work that would otherwise flood this context window.",
	"Do not delegate something you can finish in one or two tool calls yourself.",
	"After spawning, do not wait or poll: the result arrives as a steer message. Keep working, or end your turn.",
	"Write each task as a complete brief — a subagent cannot see this conversation.",
	"The subagent reports its result itself, so state the exact output you want — that text is what comes back.",
];

/**
 * The `profile` parameter only exists when profiles are enabled — the model is
 * never offered a knob that would do nothing.
 */
function buildParameters(config: TinysubagentConfig) {
	const properties: Record<string, TSchema> = {
		agent: Type.Optional(
			Type.String({
				description: "Role to run, from the list in this tool's description. Use with `task`.",
			}),
		),
		task: Type.Optional(
			Type.String({
				description:
					"Complete, self-contained brief. The subagent cannot see this conversation, so include all needed context and state the exact output you want.",
			}),
		),
		name: Type.Optional(
			Type.String({ description: "Label for the pane and the result. Defaults to the agent name." }),
		),
		tasks: Type.Optional(
			Type.Array(
				Type.Object({
					agent: Type.String({ description: "Role to run." }),
					task: Type.String({ description: "Self-contained brief for this subagent." }),
					name: Type.Optional(Type.String({ description: "Label for this subagent." })),
					profile: Type.Optional(Type.String({ description: "Profile for this subagent." })),
				}),
				{
					maxItems: MAX_PARALLEL_TASKS,
					description: `Parallel subagents, each with its own pane. Results come back together in one message. Maximum ${MAX_PARALLEL_TASKS}.`,
				},
			),
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the subagents. Defaults to this session's cwd." }),
		),
	};

	if (config.enableProfiles) {
		properties.profile = Type.Optional(Type.String({ description: profileParamDescription(config) }));
	}
	return Type.Object(properties);
}

function failure(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "error", error: message },
		isError: true,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────────────────────

export default function tinysubagent(pi: ExtensionAPI): void {
	if (!isInsideHerdr()) return;

	const { config, warnings: configWarnings } = loadConfig();
	const parameters = buildParameters(config);
	// Roles are advertised at registration time, when there is no session context
	// yet — the process cwd is the best available answer.
	const advertisedAgents = discoverAgents(process.cwd()).agents;

	/** Watchers still running, so a shutdown can end them. */
	const watchers = new Set<AbortController>();
	let shuttingDown = false;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI || configWarnings.length === 0) return;
		try {
			ctx.ui.notify(configWarnings.join("\n"), "warning");
		} catch {
			// A notification is not worth failing a session for.
		}
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const watcher of watchers) watcher.abort();
		watchers.clear();
	});

	function deliver(results: SubagentResult[]): void {
		if (shuttingDown || results.length === 0) return;
		pi.sendMessage(
			{
				customType: "tinysubagent_result",
				content: buildResultText(results),
				display: true,
				details: buildResultDetails(results),
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	/**
	 * Wait for a whole batch, then report once. Children settle independently and
	 * a watcher always ends — on a report, on an exit code, or on the pane
	 * disappearing — so a batch cannot hang on one dead child.
	 */
	async function watchBatch(runnings: readonly RunningSubagent[]): Promise<void> {
		const controllers = runnings.map(() => {
			const controller = new AbortController();
			watchers.add(controller);
			return controller;
		});

		const settled = await Promise.all(
			runnings.map(async (running, index) => {
				const controller = controllers[index];
				const outcome = await waitForSubagent(running, controller?.signal);
				if (controller) watchers.delete(controller);

				// The child's pi is gone by the time a completion lands, so this only
				// reaps a pane that outlived it. A failure is left on screen instead,
				// so the reason stays readable.
				if (outcome.kind === "completed") void herdrPaneClose(running.paneId);

				return {
					name: running.name,
					agent: running.agent,
					profile: running.profile,
					paneId: running.paneId,
					task: running.task,
					outcome,
					elapsedMs: Date.now() - running.startedAt,
					sessionFile: running.sessionFile,
				} satisfies SubagentResult;
			}),
		);

		deliver(settled);
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: buildToolDescription(advertisedAgents, config),
		promptSnippet: "Delegate a task to a subagent running in its own herdr pane",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const params = rawParams as ToolParams;

			const problem = await ensureHerdrReady();
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
			};

			// Launch sequentially: panes are created one at a time anyway, and a
			// partly-failed batch reports exactly which children did start.
			const spawned: { name: string; paneId: string; profile: string | null; warnings: string[] }[] = [];
			const failures: { agent: string; error: string }[] = [];
			const runnings: RunningSubagent[] = [];

			for (const request of mode.requests) {
				const result = await spawnOne(request, context);
				if (result.ok) {
					runnings.push(result.running);
					spawned.push({
						name: result.running.name,
						paneId: result.running.paneId,
						profile: result.running.profile,
						warnings: result.warnings,
					});
				} else {
					failures.push({ agent: request.agent, error: result.error });
				}
			}

			if (runnings.length > 0) void watchBatch(runnings);

			const lines = [
				...spawned.map(
					(entry) => `spawned ${entry.name} (pane ${entry.paneId})${entry.profile ? ` [${entry.profile}]` : ""}`,
				),
				...failures.map((entry) => `failed ${entry.agent}: ${entry.error}`),
				...spawned.flatMap((entry) => entry.warnings),
			];

			const note =
				runnings.length === 0
					? "Nothing was launched."
					: "Results arrive as a steer message when the subagents finish. Do not poll or wait — end your turn or keep working.";

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
	});
}
