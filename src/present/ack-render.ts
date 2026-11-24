/**
 * The spawn acknowledgment as the TUI draws it: the same parts `ackLine` emits,
 * with one theme colour each. The model-facing text stays plain, so nothing
 * here affects what the model reads.
 *
 * Deliberately free of any `src/pi/` import so a future tool module can render
 * acknowledgments without a cycle back through it.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ShareCost } from "../children/contract.ts";
import type { ResolvedProfile } from "../config/profiles.ts";
import { isThinkingLevel, type ThinkingLevel } from "../types.ts";
import { ackParts, type SpawnAck } from "./ack.ts";
import type { ResultDetail } from "./result.ts";

/** One child as the spawn acknowledgment reports it. */
export interface SpawnedEntry {
	agent: string;
	name: string;
	/** The child's pane, when it was supervised as one; absent for a process. */
	paneId?: string;
	profile: ResolvedProfile | null;
	/** Present only for a child given the orchestrator's context. */
	sharedContext?: ShareCost;
	warnings: string[];
}

/** Every part of a call's outcome the TUI renders: spawn lines or a finished report. */
export interface AckDetails {
	/** `running`, `started`, `finished`, or `error`. */
	status?: string;
	/**
	 * The live view of a batch that is still running: one line per child. Present
	 * only on a partial update, so the finished result never carries a tail the
	 * report would then repeat.
	 */
	live?: string[];
	error?: string;
	spawned?: SpawnedEntry[];
	failed?: { agent: string; error: string }[];
	/** Role warnings and routing warnings, in the order the model reads them. */
	warnings?: string[];
	/** A finished batch's results, so the report can be drawn with colour. */
	results?: ResultDetail[];
}

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
 * The live view as the TUI draws it: one row per child, cut to the width the
 * host offers, never wrapped.
 *
 * `truncateToWidth` is what makes the second half true. `Text` word-wraps, so a
 * long streamed tail would take rows the view does not own and push the batch
 * above it — the scrolling region this view must not have. A cut line ends in
 * the ellipsis, so an incomplete tail is never mistaken for the child's last
 * word.
 */
export function liveLinesComponent(lines: readonly string[]): Component {
	return {
		render(width: number): string[] {
			return lines.map((line) => truncateToWidth(line, width));
		},
		invalidate(): void {
			// Nothing is cached: each render reads the lines the update carried.
		},
	};
}

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
	// The share's size is a fact about cost, not a fact about the role: dim, so a
	// long row still reads as "who, where, how expensive".
	if (parts.share !== null) line += ` ${theme.fg("dim", parts.share)}`;
	return line;
}
