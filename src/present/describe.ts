/**
 * The tool's advertised surface: the description the model reads, the prompt
 * guidelines, and the parameter schema the model is offered.
 *
 * Every string here is part of the tool contract — the model chooses roles and
 * writes briefs from this text — so the wording is deliberate and asserted by
 * tests. Nothing here touches I/O or module state.
 *
 * The supervision mode is an input to the description and the schema, because a
 * pane host is one of two modes rather than the only one: nothing the model reads
 * here may promise a pane that a plain terminal will not open.
 */

import { Type, type TSchema } from "typebox";
import type { LaunchMode } from "../children/harness/index.ts";
import { MAX_PARALLEL_TASKS } from "../children/requests.ts";
import { CURRENT_PROFILE, type TinysubagentConfig } from "../config/config.ts";
import { availableProfileNames, profileParamDescription } from "../config/profiles.ts";
import { routingActive } from "../systemone/route.ts";
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

/**
 * The prompt snippet: the one line the model reads under the tool's name. A pane
 * host opens a pane per subagent, a plain terminal starts a headless process, and
 * the line has to say which — it is the first promise the model sees.
 */
export function buildPromptSnippet(mode: LaunchMode = "pane"): string {
	return mode === "pane"
		? "Delegate a task to a subagent running in its own herdr pane"
		: "Delegate a task to a subagent running as its own headless process";
}

/** How a child is supervised, in the words the model is given for it. */
function supervisionPhrase(mode: LaunchMode): string {
	return mode === "pane" ? "running in its own herdr pane" : "running as its own process";
}

/**
 * What the call's ending is, in this mode. A pane host can relay an interrupt into
 * the panes and close them after; a plain child cannot be steered, so the honest
 * promise stops at the wait and at how the children are reported.
 */
function interruptSentence(mode: LaunchMode): string {
	return mode === "pane"
		? "A human may interrupt the turn: the interrupt is relayed to every live subagent, stopping each turn where it is, the wait returns at once, and the subagents' panes are closed."
		: "A human may interrupt the turn: the wait returns at once, and every subagent that had started is reported as interrupted.";
}

export function buildToolDescription(
	agents: readonly AgentDef[],
	config: TinysubagentConfig,
	mode: LaunchMode = "pane",
): string {
	// The advice must match the schema: with profiles off, `profile` is not a
	// parameter at all, and naming a role there kills the whole batch.
	const taskFields = config.enableProfiles
		? "Specify `name` and `profile` per task when needed."
		: "Each task's `agent` is one of the roles below, and a role name is never a `profile`: specify `name` when needed, but never a `profile`, because profiles are disabled here — every subagent runs on this session's model and thinking level.";
	const lines = [
		// Whether a child can be handed this conversation decides which promise is
		// true: with the capability off, isolation is the whole point of a subagent.
		config.canShareContext
			? `Delegate tasks to subagents, each ${supervisionPhrase(mode)} with its own context window.`
			: `Delegate tasks to subagents, each ${supervisionPhrase(mode)} with an isolated context window.`,
		"Calling this tool starts the requested subagent(s) immediately; it does not queue or defer them for later. All requested subagents run concurrently.",
		"",
		`This call returns when every subagent has finished, with all their reports in one result. Do nothing else while it runs: you cannot start a second batch until it returns. ${interruptSentence(mode)}`,
		"",
		`Provide a \`tasks\` array with one or more subagents (up to ${MAX_PARALLEL_TASKS}). Subagents run concurrently and their reports come back together in a single result. ${taskFields}`,
		"",
	];

	// The sharing advice is its own section, ahead of the role list: a list of
	// "Don't share when" bullets running straight into `- \`planner\`` looks like
	// one list belonging to the "Available roles" heading.
	if (config.canShareContext) {
		lines.push(
			"Share context:",
			"`shareContext: true` on a task forks this conversation into that subagent's own session, so it starts with the shared context that led to its brief. A shared context is background, not an instruction: the brief is still what it answers to.",
			"",
			"Share when",
			"- The task depends on earlier decisions, constraints, or user preferences that can't be recovered from the codebase or restated briefly.",
			"- It continues work you've already done (e.g. you found the root cause, now delegate the fix).",
			"- Re-discovering the information would be expensive or error-prone (long traces, verified findings).",
			"- Output must stay consistent with interfaces, names, or schemas you already defined.",
			"- A parallel subagent needs to know its boundaries (what else is in progress, what not to touch).",
			"",
			"Don't share when",
			"- The task is self-contained and fits in a few sentences (search, summarize, run tests).",
			"- You want an independent result: review, audit, verification, second opinion. Your reasoning would anchor it.",
			"- The context is mostly irrelevant: old topics, dead ends, long tool outputs.",
			"- The context contains secrets or private data the subagent doesn't need.",
			"- You're unsure it helps. Put the one or two key facts in the task description instead.",
			"",
		);
	}

	lines.push("Available roles:");
	if (agents.length === 0) {
		lines.push("- (none found)");
	} else {
		lines.push(...advertiseAgents(agents));
	}

	if (config.enableProfiles) {
		lines.push(
			"",
			`Profiles: ${availableProfileNames(config, mode)
				.map((name) => `\`${name}\``)
				.join(", ")}. \`${CURRENT_PROFILE}\` is the default and runs on this session's model and thinking level.`,
		);
		if (routingActive(config, mode)) {
			lines.push("Omit `profile` to choose automatically for each task.");
		}
	}

	return lines.join("\n");
}

/**
 * The brief guideline, in its two forms. With sharing available, "cannot see this
 * conversation" would be false, and the child must still be given something that
 * stands on its own — a shared context is background, never the instruction.
 */
const BRIEF_GUIDELINE = "Write each task as a complete brief — a subagent cannot see this conversation.";
const SHARED_BRIEF_GUIDELINE =
	"Write each task as a complete brief: a shared context is background, not an instruction — even with `shareContext: true` the brief must still stand on its own.";

/** The prompt guidelines for this config. Gated for the same reason `profile` is. */
export function buildPromptGuidelines(config: TinysubagentConfig): string[] {
	return [
		"Use subagent to delegate self-contained work that would otherwise flood this context window.",
		"Calling subagent starts the requested agent(s) immediately; it does not queue work for later.",
		"Do not delegate something you can finish in one or two tool calls yourself.",
		"While subagents run, do nothing else: the call returns when they have all finished, and a second batch cannot start until it does. Do not poll, sleep, or start unrelated work.",
		config.canShareContext ? SHARED_BRIEF_GUIDELINE : BRIEF_GUIDELINE,
		"The subagent reports its result itself, so state the exact output you want — that text is what comes back.",
	];
}

/**
 * Per-task `profile` exists whenever profiles are enabled. During automatic
 * routing, an explicitly supplied profile overrides the router.
 *
 * `shareContext` exists only when the capability is on: the key is left out of
 * the task object while the gate is off, so the model is never offered it. The
 * task object stays open (`additionalProperties` is not closed) because pi
 * validates every call against this schema before `execute` runs: a benign extra
 * key must never fail a whole batch. A share the gate does not permit is refused
 * by name in the tool body, before any pane opens.
 */
export function buildParameters(config: TinysubagentConfig, mode: LaunchMode = "pane") {
	const profileOffered = config.enableProfiles;
	const tasksDescription =
		mode === "pane"
			? `Subagents, each with its own pane. The call returns one result with every report. Maximum ${MAX_PARALLEL_TASKS}.`
			: `Subagents, each started as its own process. The call returns one result with every report. Maximum ${MAX_PARALLEL_TASKS}.`;
	const properties: Record<string, TSchema> = {
		tasks: Type.Array(
			Type.Object({
				agent: Type.String({ description: "Role to run." }),
				task: Type.String({ description: "Self-contained brief for this subagent." }),
				name: Type.Optional(Type.String({ description: "Label for this subagent." })),
				...(profileOffered
					? { profile: Type.Optional(Type.String({ description: "Profile for this subagent." })) }
					: {}),
				...(config.canShareContext
					? {
						shareContext: Type.Optional(
							Type.Boolean({
								description:
									"Start this subagent with a fork of this conversation as background. The brief is still what it answers to.",
							}),
						),
					}
					: {}),
			}),
			{
				minItems: 1,
				maxItems: MAX_PARALLEL_TASKS,
				description: tasksDescription,
			},
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the subagents. Defaults to this session's cwd." }),
		),
	};

	return Type.Object(properties);
}
