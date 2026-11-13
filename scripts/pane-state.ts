/**
 * Reading a live pi pane from its text.
 *
 * The interrupt smoke needs the pane's text for one thing only: knowing a child is
 * mid-work, so the keystroke it sends lands on a running turn rather than on an
 * idle prompt. `readPane` is that read, and `waitBusy` in the smoke is what uses
 * it — the child's bash call has to be visible before anything is interrupted.
 *
 * Whether the turn *stopped* is no longer read off the screen: an interrupt closes
 * the pane, and a closed pane is the proof the child is gone and its turn with
 * it. A screen that still says `Working` would only be evidence of a stop that did
 * not land, and there is nothing left to read it from once the pane is closed.
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
 * The default read is the scrollback, which is where the child's bash call still
 * shows after pi has scrolled past its start. A failed read is an empty screen
 * rather than a throw: every caller is polling, and a pane slow to answer is not
 * a verdict on what the pane is doing.
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
