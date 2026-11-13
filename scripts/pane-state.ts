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
 * Both readings take a `readPane` result, and both fail towards a visible failure:
 * a screen that still says `Working` counts as running, so a stop that did not
 * happen is a timeout with the pane printed, never a silent pass.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How much scrollback a read asks for: enough to hold a call that has scrolled. */
const SCROLLBACK_LINES = 80;

/** What `readPane` wants from the pane. */
export interface ReadPaneOptions {
	/** Read the screen as it is now, not the scrollback above it. */
	visible?: boolean;
}

/**
 * Read a pane's text, or `""` if herdr could not read it.
 *
 * The default read is the scrollback, which is where an earlier call still shows;
 * `visible` asks for the screen as it stands, which is the only place a running
 * turn can be told from a stopped one. A failed read is an empty screen rather
 * than a throw: every caller is polling, and a pane slow to answer is not a
 * verdict on what the pane is doing.
 */
export async function readPane(paneId: string, options: ReadPaneOptions = {}): Promise<string> {
	const source = options.visible ? ["--source", "visible"] : ["--lines", String(SCROLLBACK_LINES)];
	try {
		const { stdout } = await run(process.env.HERDR_BIN_PATH || "herdr", [
			"pane",
			"read",
			paneId,
			"--format",
			"text",
			...source,
		]);
		return stdout;
	} catch {
		return "";
	}
}

/** Whether the pane still shows pi's working status line. */
export function runningTurn(text: string): boolean {
	return /\bWorking\b/.test(text);
}

/** Whether the pane still shows pi's footer — a live child at its prompt. */
export function atPrompt(text: string): boolean {
	return /↑[^\n]*↓/.test(text);
}
