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

/** The plain line: what the model reads, with nothing to parse and no escapes. */
export function ackLine(ack: SpawnAck): string {
	const parts = ackParts(ack);
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
