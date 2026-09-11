/**
 * The spawn acknowledgment as the TUI draws it: the same parts `ackLine` emits,
 * with one theme colour each. The model-facing text stays plain, so nothing
 * here affects what the model reads.
 *
 * Deliberately free of any `src/pi/` import so a future tool module can render
 * acknowledgments without a cycle back through it.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ResolvedProfile } from "../config/profiles.ts";
import { isThinkingLevel, type ThinkingLevel } from "../types.ts";
import { ackParts, type SpawnAck } from "./ack.ts";

/** One child as the spawn acknowledgment reports it. */
export interface SpawnedEntry {
	agent: string;
	name: string;
	paneId: string;
	profile: ResolvedProfile | null;
	warnings: string[];
}

export interface AckDetails {
	status?: string;
	error?: string;
	spawned?: SpawnedEntry[];
	failed?: { agent: string; error: string }[];
}

export const NOTE_STARTED =
	"Results arrive as a steer message when the subagents finish. Wait for that message — do nothing else: end your turn, and do not poll or start unrelated work.";
export const NOTE_NOTHING = "Nothing was launched.";

/** Thinking levels carry their own theme colours, so the level is readable at a glance. */
export const THINKING_COLORS: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/**
 * The coloured form of `ackLine`: same parts, same order, one colour each. The
 * role is the row's title, the label is the accent, the profile that was asked
 * for is green, the model it resolved to is dim, and thinking keeps its own
 * level colour.
 */
export function renderAck(ack: SpawnAck, theme: Theme): string {
	const parts = ackParts(ack);
	let line = theme.fg("toolTitle", theme.bold(parts.role));
	line += ` ${theme.fg("muted", "(")}${theme.fg("accent", parts.name)}${theme.fg("muted", ")")}`;
	if (parts.profile !== null) line += ` ${theme.fg("success", `[${parts.profile}]`)}`;
	if (parts.model !== null) line += ` ${theme.fg("dim", parts.model)}`;
	if (parts.thinking !== null) {
		const color = isThinkingLevel(parts.thinking) ? THINKING_COLORS[parts.thinking] : "muted";
		line += ` ${theme.fg("muted", "(")}${theme.fg(color, parts.thinking)}${theme.fg("muted", ")")}`;
	}
	return line;
}
