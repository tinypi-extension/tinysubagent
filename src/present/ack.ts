/**
 * The spawn acknowledgment line.
 *
 * One line per child, in the shape:
 *
 *   Scout (scout-mcp-capability-check) [current] oc-openai/deepseek-flash (medium)
 *
 * role, label, the profile it was launched under, and the model/thinking that
 * profile resolved to. Splitting the line into parts here (rather than into a
 * string) is what lets `index.ts` colour each part for the TUI while the model
 * reads the plain form — the two renderings are built from the same parts, so
 * they cannot drift apart.
 */

import type { ResolvedProfile } from "../config/profiles.ts";

export interface SpawnAck {
	agent: string;
	name: string;
	profile: ResolvedProfile | null;
}

/** One child as the spawn notice reports it: the ack parts plus who picked the profile. */
export interface SpawnNoticeEntry extends SpawnAck {
	/** True when the classifier model chose the profile rather than the caller. */
	routedByClassifier?: boolean;
}

/** The notice's single prefix, so each line reads as an event rather than a report. */
export const SPAWN_NOTICE_PREFIX = "tinysubagent: spawned";

/** Marks a profile the classifier model chose; the orchestrator was not the one deciding. */
export const CLASSIFIER_NOTE = "(by classifier model)";

/** The parts of the line, before separators and parentheses are applied. */
export interface AckParts {
	role: string;
	name: string;
	profile: string | null;
	model: string | null;
	thinking: string | null;
}

/**
 * `scout` -> `Scout`, `code-reviewer` -> `Code-Reviewer`. The agent name is a
 * lowercase id; the line reads as a role, so it is title-cased rather than
 * repeated verbatim.
 */
export function roleLabel(agent: string): string {
	return agent
		.split(/([-_\s]+)/)
		.map((part) => (/^[-_\s]*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("");
}

export function ackParts(ack: SpawnAck): AckParts {
	return {
		role: roleLabel(ack.agent),
		name: ack.name,
		profile: ack.profile?.name ?? null,
		model: ack.profile?.model ?? null,
		thinking: ack.profile?.thinking ?? null,
	};
}

/**
 * The notice for a request that was skipped because its Label is already
 * running. Informational, not a failure: the work was refused only because a
 * child by that Label is still going, so the orchestrator should wait for it
 * rather than start a second one.
 */
export function skipNotice(label: string): string {
	return `skipped ${label}: a subagent with this label is already running.`;
}

/** The parts as one line: whatever resolved, in a fixed order, nothing empty. */
function joinParts(parts: AckParts): string {
	return [
		parts.role === "" ? null : parts.role,
		`(${parts.name})`,
		parts.profile === null ? null : `[${parts.profile}]`,
		parts.model,
		parts.thinking === null ? null : `(${parts.thinking})`,
	]
		.filter((part): part is string => part !== null)
		.join(" ");
}

/** The plain line: what the model reads, with nothing to parse and no escapes. */
export function ackLine(ack: SpawnAck): string {
	return joinParts(ackParts(ack));
}

/**
 * The notice the user sees the moment a batch has started: the role, the label,
 * the profile it launched under, and the provider/model that profile resolved
 * to. A profile the classifier model picked says so, so a routed spawn is never
 * mistaken for one the caller chose.
 *
 * One line per child. A batch of several says how many it started and then
 * lists them underneath, so a multi-spawn call stays readable at a glance.
 */
export function spawnNotice(entries: readonly SpawnNoticeEntry[]): string {
	if (entries.length === 0) return "";
	const lines = entries.map((entry) => {
		const parts = ackParts(entry);
		if (entry.routedByClassifier && parts.profile !== null) {
			parts.profile = `${parts.profile} ${CLASSIFIER_NOTE}`;
		}
		return joinParts(parts);
	});
	const first = lines[0] ?? "";
	if (lines.length === 1) return `${SPAWN_NOTICE_PREFIX} ${first}`;
	return [`${SPAWN_NOTICE_PREFIX} ${lines.length} subagents`, ...lines.map((line) => `  ${line}`)].join("\n");
}
