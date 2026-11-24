/**
 * Relaying an orchestrator interrupt to the children.
 *
 * One Esc per live sub pane — the same keystroke the operator would use by
 * hand — so a child that is mid-turn stops where it is. Nothing is killed: the
 * worst case is a child that has to be re-prompted. The pane is then closed, but
 * that is the caller's follow-up, not this function's: closing here would race
 * the Esc and a pane still busy would lose the keystroke.
 *
 * Three deliberate choices live here:
 *
 *   1. Every tracked pane is relayed to, idle children included. Mid-turn state
 *      is never detected: probing each child would add a round trip to the
 *      interrupt path, and a pane that opened *during* the abort would still
 *      need its own Esc. The bluntness is the design — an Esc
 *      at a prompt is harmless, a missed Esc is not.
 *   2. The relay is awaitable but never throws. Herdr resolves as soon as the
 *      sends are issued; Rex resolves after each send-key finishes, so a
 *      caller can close a pane only once its Esc has landed. Every host error
 *      is swallowed: a pane that is already gone must produce no warning, no
 *      failure and no change to the result. One pane failing never stops the
 *      rest of the fan-out.
 *   3. Once per interrupt, not once per pane: this function carries no memory,
 *      so it sends an Esc to each id it is handed. The caller owns the "one
 *      relay per interrupt" guard — the batch watcher's `forward` runs once,
 *      which is what keeps a second Esc from being typed.
 */

import { paneChild } from "../pane-host/index.ts";

/**
 * Stop every pane this batch can see by typing one Esc into it. Awaits the
 * supervisors that own the panes, never throws and never reports failure; an
 * empty list stops nothing.
 *
 * A pane id is handed in because the column tracker, and the panes an earlier
 * call left idle, are addressed by pane id alone: each one is a pane child of
 * the pane supervisor, and stopping it is that supervisor's own operation.
 */
export async function relayInterrupt(paneIds: readonly string[]): Promise<void> {
	await Promise.all(paneIds.map((paneId) => {
		const child = paneChild(paneId);
		return child.supervisor.stop(child);
	}));
}
