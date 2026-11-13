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
import type { ResultDetail } from "./result.ts";

/** One child as the spawn acknowledgment reports it. */
export interface SpawnedEntry {
	agent: string;
	name: string;
	paneId: string;
	profile: ResolvedProfile | null;
	warnings: string[];
}

/** Every part of a call's outcome the TUI renders: spawn lines or a finished report. */
export interface AckDetails {
	/** `started`, `finished`, `skipped`, or `error`. */
	status?: string;
	error?: string;
	spawned?: SpawnedEntry[];
	failed?: { agent: string; error: string }[];
	/** Labels skipped because a subagent already holds them. Informational. */
	skipped?: string[];
	/** Role warnings and routing warnings, in the order the model reads them. */
	warnings?: string[];
	/** A finished batch's results, so the report can be drawn with colour. */
	results?: ResultDetail[];
}

export const NOTE_NOTHING = "Nothing was launched.";
export const NOTE_ALL_SKIPPED =
	"Nothing was launched: every requested label is already running. Those children's reports come back in the result of the call that started them — nothing is delivered here, and nothing arrives later.";

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
