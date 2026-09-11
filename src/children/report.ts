/**
 * The child's report sidecar: the single byte-writer the orchestrator polls.
 *
 * Two callers stamp the same file — the explicit `subagent_report` hand-back and
 * the settle fallback — so the atomic write lives here once and both route
 * through it. The write stages a temp file beside the target and renames it, so
 * a reader sees either the old file or the complete new one, never a half-written
 * mixture.
 *
 * The sidecar contract is frozen: `{"type":"done"}` for a finished child,
 * `{"type":"done","result":…}` for an explicit hand-back, and
 * `{"type":"failed","reason":…[,"message":…]}` for a failure.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";

/** The two things a settle can report to the orchestrator. */
export type ChildSettle = "done" | "failed";

/** Path of the sidecar to stamp, or null when this pi is not a subagent. */
function reportFilePath(): string | null {
	const file = process.env.PI_TINYSUBAGENT_REPORT;
	return file && file !== "" ? file : null;
}

/**
 * Write `payload` so a reader sees either the old file or the complete new one,
 * never a half-written mixture.
 *
 * Temp file beside the target, then a rename: `renameSync` is only atomic within
 * one filesystem, so a tmpdir would defeat the point. This matters because the
 * sidecar grows from a ~20-byte signal to a full result document, and a torn read
 * of it would be classified by the watcher's "malformed ⇒ settled" rule as a
 * completion carrying the wrong text.
 */
function writeAtomic(file: string, payload: unknown): boolean {
	const staging = `${file}.tmp`;
	try {
		writeFileSync(staging, JSON.stringify(payload), "utf8");
		renameSync(staging, file);
		return true;
	} catch {
		// Leave nothing behind for a later read to trip over.
		try {
			rmSync(staging, { force: true });
		} catch {
			// Best effort: the staging name is never read by the watcher anyway.
		}
		return false;
	}
}

/**
 * Write the sidecar. False when there is no path, or the write failed.
 *
 * `detail` is the failure reason, `message` the human-readable explanation of it.
 * Only a failure can carry a message, and only one that has no turn behind it
 * needs to: every other failure leaves its reason in the session, where the
 * watcher already looks.
 */
export function writeReportFile(settle: ChildSettle, detail?: string, message?: string): boolean {
	const file = reportFilePath();
	if (!file) return false;
	const note = message?.trim();
	const payload =
		settle === "done"
			? { type: "done" }
			: note
				? { type: "failed", reason: detail ?? "error", message: note }
				: { type: "failed", reason: detail ?? "error" };
	return writeAtomic(file, payload);
}

/**
 * Write the child's result explicitly, so the orchestrator delivers what the
 * child said rather than what it can scrape out of the session.
 *
 * False when there is no path, or the write failed — the caller must then keep
 * the child alive and let the settle path recover the result instead of dying
 * with it unreported.
 */
export function writeResultReport(result: string): boolean {
	const file = reportFilePath();
	if (!file) return false;
	return writeAtomic(file, { type: "done", result });
}
