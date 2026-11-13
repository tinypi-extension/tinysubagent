/**
 * Relaying an orchestrator interrupt to the children.
 *
 * One Esc per live child pane — the same keystroke the operator would use by
 * hand — so a child that is mid-turn stops where it is and the human can
 * redirect it. Nothing is closed and nothing is killed: the worst case is a
 * child that has to be re-prompted.
 *
 * Three deliberate choices live here:
 *
 *   1. Once per pane. An id already relayed to is never typed into again, so a
 *      second Esc, or an Esc that arrives after the call already aborted, is a
 *      no-op. The interrupt never escalates.
 *   2. Every tracked pane is relayed to, idle children included. Mid-turn state
 *      is never detected: probing each child would cost a round trip on the path
 *      that is supposed to return at once, and a pane that opened *during* the
 *      abort would still need its own Esc. The bluntness is the design — an Esc
 *      at a prompt is harmless, a missed Esc is not.
 *   3. Fire and forget. Sending is never awaited (the call returns as soon as
 *      the relay is issued) and every rejection is swallowed, because a pane
 *      that is already gone, or a herdr error, must produce no warning, no
 *      failure and no change to the result.
 */

import { herdrPaneSendEsc } from "../herdr/cli.ts";

export interface InterruptRelay {
	/** Relay one Esc into this pane, at most once. Never awaits, never throws. */
	relayOne(paneId: string): void;
	/** Relay one Esc into each id, skipping the ones already relayed. Never throws. */
	relayAll(paneIds: readonly string[]): void;
}

export function createInterruptRelay(): InterruptRelay {
	const relayed = new Set<string>();

	const relayOne = (paneId: string): void => {
		if (relayed.has(paneId)) return;
		relayed.add(paneId);
		void herdrPaneSendEsc(paneId).catch(() => {});
	};

	return {
		relayOne,
		relayAll(paneIds) {
			for (const paneId of paneIds) relayOne(paneId);
		},
	};
}
