/**
 * The live view of a running batch: one line per child, redrawn on a cadence.
 *
 * The view is a snapshot, not a log. Each child's line opens with its spawn
 * acknowledgment — role, label, profile, the model it resolved to — then the
 * elapsed time since the spawn, then the last line of the text the child is
 * writing. A child that says nothing still has a line, because the wait itself
 * is the news; its elapsed time is what moves.
 *
 * Redraws are coalesced. A streamed chunk only updates the child's tail; the
 * repeating ticker is the only thing that draws, so a fast child costs the same
 * redraws as a quiet one and the reader callback never renders. The cadence is
 * `LIVE_CADENCE_MS` unless a caller (a test) supplies its own ticker or clock.
 *
 * The view does not scroll. Text beyond the last line is dropped, the stored
 * tail is capped, and the renderer cuts each line to the width it is given
 * rather than wrapping it. Nothing here knows the terminal, the theme, or pi.
 */

import { createEventTextReader } from "../children/event-stream.ts";
import type { ShareCost } from "../children/contract.ts";
import type { ResolvedProfile } from "../config/profiles.ts";
import { ackLine } from "../present/ack.ts";
import { formatDuration } from "../present/result.ts";

/**
 * How often the view is redrawn while the batch runs: frequent enough to read
 * as live, slow enough that a child writing fast cannot flood the renderer.
 */
export const LIVE_CADENCE_MS = 250;

/**
 * The most tail text one line keeps. Only the last line is ever shown, so this
 * is a memory bound on a single very long line, not a visible limit: the
 * renderer still cuts the line to the terminal's width.
 */
const MAX_TAIL_CHARS = 500;

/** One child as the live view needs it: exactly the parts of its ack, plus when it started. */
export interface LiveChild {
	agent: string;
	name: string;
	profile: ResolvedProfile | null;
	/** Present only for a child given the orchestrator's context. */
	sharedContext?: ShareCost;
	startedAt: number;
}

/** Start a repeating tick and return its stop. Injectable so a test owns time. */
export type LiveTicker = (ms: number, tick: () => void) => () => void;

/** The cadence, ticker and clock of a live view; production's defaults when absent. */
export interface LiveLineTuning {
	cadenceMs?: number;
	every?: LiveTicker;
	now?: () => number;
}

export interface LiveLineOptions extends LiveLineTuning {
	/** Receives the whole view on every tick, and an empty view when cleared. */
	onLines: (lines: readonly string[]) => void;
}

export interface LiveLines {
	/** The stdout subscriber for child `index`; the index is the spawn order. */
	reader(index: number): (chunk: string) => void;
	/** Draw the spawn acknowledgment and start the cadence. */
	start(): void;
	/** Stop the cadence, forget every tail, and report an empty view once. */
	clear(): void;
}

const defaultTicker: LiveTicker = (ms, tick) => {
	const handle = setInterval(tick, ms);
	handle.unref();
	return () => clearInterval(handle);
};

/** One child's followed text: the line being written and the last line it finished. */
interface Followed {
	child: LiveChild;
	pending: string;
	tail: string;
}

/**
 * Fold one text delta into the state. Only the last line is kept: a completed
 * line replaces the previous one, and the line currently arriving replaces it
 * again as it grows. Nothing accumulates above the last line, so there is
 * nothing to scroll.
 */
function advance(state: Followed, text: string): void {
	const combined = state.pending + text;
	const newline = combined.lastIndexOf("\n");
	if (newline === -1) {
		state.pending = combined;
	} else {
		const completed = combined
			.slice(0, newline)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		if (completed.length > 0) state.tail = completed[completed.length - 1] ?? "";
		state.pending = combined.slice(newline + 1);
	}

	// A line still arriving is what the view shows; a just-completed line stays
	// until the next one begins, so a delta ending in LF does not blank the row.
	const current = state.pending.trim();
	if (current !== "") state.tail = current;
	state.tail = state.tail.slice(-MAX_TAIL_CHARS);
	state.pending = state.pending.slice(-MAX_TAIL_CHARS);
}

export function createLiveLines(children: readonly LiveChild[], options: LiveLineOptions): LiveLines {
	const now = options.now ?? Date.now;
	const every = options.every ?? defaultTicker;
	const cadenceMs = options.cadenceMs ?? LIVE_CADENCE_MS;
	const states: Followed[] = children.map((child) => ({ child, pending: "", tail: "" }));
	const readers = states.map((state) =>
		createEventTextReader((text) => {
			advance(state, text);
		}),
	);

	let stop: (() => void) | null = null;
	let started = false;
	let cleared = false;

	const lines = (): string[] =>
		states.map(({ child, tail }) =>
			[ackLine(child), formatDuration(now() - child.startedAt), tail].filter((part) => part !== "").join(" · "),
		);

	const draw = (): void => {
		if (!cleared) options.onLines(lines());
	};

	return {
		reader: (index) => readers[index] ?? (() => {}),
		start: () => {
			// A batch with no children has nothing to acknowledge, and no ticker to
			// leave running: drawing an empty view would be a frame of its own.
			if (started || states.length === 0) return;
			started = true;
			draw();
			stop = every(cadenceMs, draw);
		},
		clear: () => {
			if (cleared) return;
			cleared = true;
			stop?.();
			stop = null;
			for (const state of states) {
				state.pending = "";
				state.tail = "";
			}
			// Only a view that was drawn needs clearing; a batch that never drew has
			// no stale frame, and an empty update would be a second no-op.
			if (started) options.onLines([]);
		},
	};
}
