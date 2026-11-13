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
 *   1. Every tracked pane is relayed to, idle children included. Mid-turn state
 *      is never detected: probing each child would cost a round trip on the path
 *      that is supposed to return at once, and a pane that opened *during* the
 *      abort would still need its own Esc. The bluntness is the design — an Esc
 *      at a prompt is harmless, a missed Esc is not.
 *   2. Fire and forget. Sending is never awaited (the call returns as soon as
 *      the relay is issued) and every rejection is swallowed, because a pane
 *      that is already gone, or a herdr error, must produce no warning, no
 *      failure and no change to the result. One pane failing never stops the
 *      rest of the fan-out.
 *   3. Once per interrupt, not once per pane: this function carries no memory,
 *      so it sends an Esc to each id it is handed. The caller owns the "one
 *      relay per interrupt" guard — the batch watcher's `forward` runs once,
 *      which is what keeps a second Esc from being typed.
 */

import { herdrPaneSendEsc } from "../herdr/cli.ts";

/**
 * Type one Esc into each pane. Never awaits, never throws, never reports
 * failure; an empty list sends nothing.
 */
export function relayInterrupt(paneIds: readonly string[]): void {
	for (const paneId of paneIds) void herdrPaneSendEsc(paneId).catch(() => {});
}
