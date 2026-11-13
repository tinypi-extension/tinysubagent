/**
 * The child's report sidecar writer: the single byte-writer for a pi child's
 * explicit hand-back.
 *
 * The explicit `subagent_report` hand-back is the only thing that writes a
 * result, so a pi child can only ever declare success. The atomic write stages a
 * temp file beside the target and renames it, so a reader sees either the old
 * file or the complete new one, never a half-written mixture.
 *
 * A content-free `{"type":"done"}` is written too, by one path only: the child's
 * own fallback once its report-reminder budget is spent (`writeDoneReport`). It
 * ends the wait without inventing a result.
 *
 * The sidecar contract is frozen: `{"type":"done","result":…}` is the only form
 * carrying text. Readers also accept a `{"type":"failed","reason":…[,"message":…]}`;
 * that one is not produced by a pi child's report path: the agy launch wrapper
 * stamps `failed / no-output` after agy exits 0 with no report, `spawnOne` stamps
 * one when the agy binary is missing, and older builds wrote the rest. The reader
 * classifies every one of them exactly as before.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";

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
 * sidecar carries a full result document, and a torn read of it would be
 * classified by the watcher's "malformed ⇒ settled" rule as a completion
 * carrying the wrong text.
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
 * Write the child's result explicitly, so the caller returns what the child said
 * rather than what it can scrape out of the session.
 *
 * False when there is no path, or the write failed — the caller must then keep
 * the child alive and say so, so the model retries. There is no settle fallback
 * to recover the *result*: an unreported turn end is only ever reminded, and
 * then — once the budget is spent — closed with a content-free completion.
 */
export function writeResultReport(result: string): boolean {
	const file = reportFilePath();
	if (!file) return false;
	return writeAtomic(file, { type: "done", result });
}

/**
 * Write the content-free `{"type":"done"}`: no result, only "this child is over".
 *
 * The last resort, reached once the child's report-reminder budget is spent. A
 * model that will not make the call would otherwise keep the caller waiting on a
 * turn that has already ended; this bounds the wait without inventing a result.
 * Readers classify it as a completion with no summary (`via: "turn-end"`).
 *
 * False when there is no path, or the write failed — the caller is then left with
 * the silence it had, and the watcher keeps waiting.
 */
export function writeDoneReport(): boolean {
	const file = reportFilePath();
	if (!file) return false;
	return writeAtomic(file, { type: "done" });
}
