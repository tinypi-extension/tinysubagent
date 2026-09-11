/**
 * Deciding when a subagent is finished, and how it finished.
 *
 * Two files tell the whole story, both living beside the child's session file:
 *
 *   <sessionFile>.done      the child's report: `{"type":"done","result":...}`
 *                           when it handed its result back explicitly, or a
 *                           content-free `{"type":"done"}` / 
 *                           `{"type":"failed","reason":...}` from the settle hook
 *   <sessionFile>.exitcode  written by the wrapper: `"<code> <runId>"`
 *
 * The exit-code sidecar carries the run id because it is the one signal
 * guaranteed to arrive even when the child could not report — and because a
 * future run reusing a session path must never be credited to this one.
 *
 * The one report that does not mean "finished" is `{"type":"failed",
 * "reason":"aborted"}`: the user interrupted the child to redirect it, and it is
 * sitting at its prompt. It is dropped, and the wait continues on the same pane.
 *
 * Detection is a poll, not a watch. Two `existsSync` calls per second cost
 * nothing next to the process this is supervising, and a poll cannot miss an
 * event the way a watch can during a reconnect or a rename. Liveness of the
 * *pane* is checked far less often, since that costs a herdr subprocess.
 */

import { readFileSync, rmSync } from "node:fs";
import { herdrPaneExists } from "./herdr.ts";
import type { ResolvedProfile } from "./profiles.ts";
import { readFailureNote, readFinalMessage } from "./session.ts";

const POLL_INTERVAL_MS = 1_000;
/** Check pane liveness every N polls — one herdr call per 5s, not per second. */
const PANE_CHECK_EVERY = 5;

export type FailureReason = "error" | "exit" | "no-output";

export type SubagentOutcome =
	/** The child reported a finished turn, exited pi cleanly, or handed back a result. */
	| { kind: "completed"; via: "turn-end" | "session-exit" | "report"; summary: string | null }
	/**
	 * The child settled on a bad ending (`error`), or its pi exited non-zero. The
	 * pane is deliberately left open in both cases.
	 */
	| { kind: "failed"; reason: FailureReason; exitCode: number | null; summary: string | null }
	/** The pane vanished without leaving any signal. */
	| { kind: "cancelled"; summary: string | null };

export interface RunningSubagent {
	id: string;
	name: string;
	agent: string | null;
	/** Resolved profile, for display only. */
	profile: ResolvedProfile | null;
	paneId: string;
	sessionFile: string;
	exitCodeFile: string;
	reportFile: string;
	startedAt: number;
	task: string;
}

/** `"<code> <runId>"` as written by the wrapper. */
function readExitCode(file: string): { code: number; id: string | null } | null {
	try {
		const raw = readFileSync(file, "utf8").trim();
		const [codeText, idText] = raw.split(/\s+/, 2);
		const code = Number.parseInt(codeText ?? "", 10);
		if (!Number.isFinite(code)) return null;
		return { code, id: idText || null };
	} catch {
		return null;
	}
}

/**
 * The child's report, as written by `src/child.ts`. A malformed file is treated
 * as a completion rather than an error: a report exists, so the child settled,
 * and the result text comes from the session either way.
 *
 * `result` is the explicit payload — present only when the child called
 * `subagent_report`. Anything that is not a non-empty string counts as
 * absent, which is what makes an old reader's output still valid input here.
 */
interface Report {
	settle: "done" | "failed";
	/** `aborted` is parsed but is never terminal — see `classify`. */
	reason: FailureReason | "aborted";
	result: string | null;
}

function readReport(file: string): Report | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8").trim();
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { type?: unknown; reason?: unknown; result?: unknown };
		if (parsed.type === "failed") {
			const reason = parsed.reason;
			return {
				settle: "failed",
				reason: reason === "aborted" || reason === "exit" || reason === "no-output" ? reason : "error",
				result: null,
			};
		}
		const result =
			typeof parsed.result === "string" && parsed.result.trim() !== "" ? parsed.result : null;
		return { settle: "done", reason: "error", result };
	} catch {
		return { settle: "done", reason: "error", result: null };
	}
}

function remove(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// Nothing to do: a sidecar we could not delete only risks a stale read by
		// a future run, and the run id guards that case.
	}
}

interface Classification {
	outcome: SubagentOutcome;
	/** Sidecars to delete once the outcome is accepted. */
	consume: string[];
}

function classify(running: RunningSubagent): Classification | null {
	const summary = () => readFinalMessage(running.sessionFile);
	// A failed turn carries its reason in the session, not in its text.
	const failure = () => summary() ?? readFailureNote(running.sessionFile);

	const report = readReport(running.reportFile);
	if (report !== null) {
		// A result the child handed back explicitly is authoritative — the session
		// text is a scrape, this is a statement — so it is read before any session
		// work and it wins even when the two disagree.
		if (report.settle === "done" && report.result !== null) {
			return {
				outcome: { kind: "completed", via: "report", summary: report.result },
				consume: [running.reportFile, running.exitCodeFile],
			};
		}
		// An interrupt is not a settlement. The user stopped this child to redirect it
		// and it is alive at its prompt, so the report is stale the moment it lands:
		// drop it and keep watching. The child's next real settle, or its pane closing,
		// is what ends this wait — the orchestrator is never told the job closed.
		if (report.reason === "aborted") {
			remove(running.reportFile);
			return null;
		}
		// The child settled and said how. A failed settle keeps its pane open —
		// the error is on screen there and the user may want to retry.
		return {
			outcome:
				report.settle === "done"
					? { kind: "completed", via: "turn-end", summary: summary() }
					: { kind: "failed", reason: report.reason, exitCode: null, summary: failure() },
			consume: [running.reportFile, running.exitCodeFile],
		};
	}

	const exit = readExitCode(running.exitCodeFile);
	if (exit !== null) {
		// A sidecar stamped with another run's id belongs to a previous run that
		// reused this session path. Consume it and keep waiting for our own.
		if (exit.id !== null && exit.id !== running.id) {
			remove(running.exitCodeFile);
			return null;
		}
		if (exit.code === 0) {
			// pi exited cleanly without reporting: the user quit the child session.
			// The work that happened is still worth returning.
			return {
				outcome: { kind: "completed", via: "session-exit", summary: summary() },
				consume: [running.exitCodeFile],
			};
		}
		return {
			outcome: { kind: "failed", reason: "exit", exitCode: exit.code, summary: failure() },
			consume: [running.exitCodeFile, running.reportFile],
		};
	}

	return null;
}

/**
 * Overridable bits of the wait loop. Only tests pass these; the defaults are what
 * production uses.
 */
export interface WatcherDeps {
	/** Pane liveness probe. Returns null when the answer is unknown. */
	paneExists?: (paneId: string) => Promise<boolean | null>;
	pollIntervalMs?: number;
}

/**
 * Resolve when the subagent is finished. Never rejects, never hangs while the
 * process is alive: a pane that disappears without a signal is reported as
 * cancelled, and an abort resolves the same way.
 */
export function waitForSubagent(
	running: RunningSubagent,
	signal?: AbortSignal,
	deps: WatcherDeps = {},
): Promise<SubagentOutcome> {
	const paneExists = deps.paneExists ?? ((paneId: string) => herdrPaneExists(paneId));

	return new Promise((resolve) => {
		let settled = false;
		let ticks = 0;

		const finish = (outcome: SubagentOutcome, consume: string[] = []): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
			for (const file of consume) remove(file);
			resolve(outcome);
		};

		const onAbort = (): void => {
			finish({ kind: "cancelled", summary: readFinalMessage(running.sessionFile) });
		};

		const check = async (): Promise<void> => {
			if (settled) return;

			const classification = classify(running);
			if (classification) {
				finish(classification.outcome, classification.consume);
				return;
			}

			ticks += 1;
			if (ticks % PANE_CHECK_EVERY !== 0) return;

			// No signal yet. If the pane itself is gone, nothing more will arrive.
			const alive = await paneExists(running.paneId);
			if (alive === false) {
				finish({ kind: "cancelled", summary: readFinalMessage(running.sessionFile) });
			}
		};

		const timer = setInterval(() => {
			void check();
		}, deps.pollIntervalMs ?? POLL_INTERVAL_MS);

		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		// First probe runs immediately: a fast failure should not wait a full tick.
		void check();
	});
}
