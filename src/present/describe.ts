/**
 * The tool's advertised surface: the description the model reads, the prompt
 * guidelines, and the parameter schema the model is offered.
 *
 * Every string here is part of the tool contract — the model chooses roles and
 * writes briefs from this text — so the wording is deliberate and asserted by
 * tests. Nothing here touches I/O or module state.
 */

import { Type, type TSchema } from "typebox";
import { MAX_PARALLEL_TASKS } from "../children/requests.ts";
import { CURRENT_PROFILE, type TinysubagentConfig } from "../config/config.ts";
import { availableProfileNames, profileParamDescription } from "../config/profiles.ts";
import { type AgentDef } from "../types.ts";

export const MAX_LISTED_AGENTS = 12;
export const MAX_ADVERTISED_DESCRIPTION = 120;

export function advertiseAgents(agents: readonly AgentDef[]): string[] {
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

export function buildToolDescription(agents: readonly AgentDef[], config: TinysubagentConfig): string {
	const lines = [
		"Delegate tasks to subagents, each running in its own herdr pane with an isolated context window.",
		"",
		"This returns as soon as the panes are open. Do nothing else after spawning: end your turn and wait for the results. Each subagent's result is delivered back to this session automatically as a steer message when it finishes — do not poll, sleep, tail logs, or start unrelated work while you wait.",
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

export const PROMPT_GUIDELINES = [
	"Use subagent to delegate self-contained work that would otherwise flood this context window.",
	"Do not delegate something you can finish in one or two tool calls yourself.",
	"After spawning, do nothing else: end your turn and wait for the result, which arrives automatically as a steer message. Do not poll, sleep, or start unrelated work.",
	"Write each task as a complete brief — a subagent cannot see this conversation.",
	"The subagent reports its result itself, so state the exact output you want — that text is what comes back.",
];

/**
 * The `profile` parameter only exists when profiles are enabled — the model is
 * never offered a knob that would do nothing.
 */
export function buildParameters(config: TinysubagentConfig) {
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
