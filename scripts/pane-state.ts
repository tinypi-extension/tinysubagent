/**
 * Reading a live pi pane from its text.
 *
 * The interrupt smoke has to tell a child that is still working from one that has
 * stopped at its prompt, using only what `herdr pane read` hands back. Two things
 * on screen carry it:
 *
 *   - pi draws its working status line — `── ⠸ Working ──…` — while a turn runs
 *     and clears it when the turn stops. Nothing else changes on an interrupt:
 *     the transcript keeps the aborted call, so the status line is the only
 *     signal that distinguishes a stopped child from a busy one.
 *   - pi's footer, with its token counters and the model, is drawn whenever pi is
 *     showing its editor. A pane still showing it is a live child at its prompt;
 *     a pane where pi has gone shows a shell prompt instead.
 *
 * Both readings are deliberately blunt and both fail towards a visible failure: a
 * screen that still says `Working` counts as running, so a stop that did not
 * happen is a timeout with the pane printed, never a silent pass.
 */

/** Whether the pane still shows pi's working status line. */
export function runningTurn(text: string): boolean {
	return /\bWorking\b/.test(text);
}

/** Whether the pane still shows pi's footer — a live child at its prompt. */
export function atPrompt(text: string): boolean {
	return /↑[^\n]*↓/.test(text);
}
