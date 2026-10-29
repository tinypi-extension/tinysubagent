/**
 * The child's report sidecar writer: the single byte-writer for a pi child's
 * explicit hand-back.
 *
 * The explicit `subagent_report` hand-back is the only thing that writes it, so
 * a pi child can only ever declare success. The atomic write stages a temp file
 * beside the target and renames it, so a reader sees either the old file or the
 * complete new one, never a half-written mixture.
 *
 * The sidecar contract is frozen: `{"type":"done","result":…}` is what this
 * writer emits. Readers still accept a content-free `{"type":"done"}` and a
 * `{"type":"failed","reason":…[,"message":…]}`. Those are not produced by a pi
 * child's report path: the agy launch wrapper stamps `failed / no-output` after
 * agy exits 0 with no report, `spawnOne` stamps one when the agy binary is
 * missing, and older builds wrote the rest. The reader classifies every one of
 * them exactly as before.
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
 * Write the child's result explicitly, so the orchestrator delivers what the
 * child said rather than what it can scrape out of the session.
 *
 * False when there is no path, or the write failed — the caller must then keep
 * the child alive and say so, so the model retries. There is no settle fallback
 * to recover the result: an unreported turn end writes nothing and waits.
 */
export function writeResultReport(result: string): boolean {
	const file = reportFilePath();
	if (!file) return false;
	return writeAtomic(file, { type: "done", result });
}
