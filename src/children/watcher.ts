/**
 * Deciding when a subagent is finished, and how it finished.
 *
 * Two files tell the whole story, both living beside the child's session file:
 *
 *   <sessionFile>.done      the child's report: `{"type":"done","result":...}`
 *                           when it handed its result back explicitly. Older
 *                           builds also wrote a content-free `{"type":"done"}` or
 *                           a `{"type":"failed","reason":...,"message":...}`;
 *                           the reader still accepts every one of those shapes.
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
 * *pane* is checked far less often, since that costs a host subprocess.
 *
 * ## The run that never started
 *
 * A child pi that refuses its prompt — no API key, an unknown model — throws
 * before the agent phase and writes nothing at all: no report, no exit code, and
 * a pane that stays alive at its prompt. Nothing would ever settle it. So after
 * `NEVER_STARTED_MS` a session file that has not grown since the child launched
 * is itself a signal: the run never began, and the wait ends `failed
 * (never-started)` rather than hanging on the blocking call. More entries than it
 * launched with, of any role, mean a run happened and the ordinary rules apply;
 * and the pane is deliberately left open, because `/login` in it is still the fix.
 *
 * "Grown since the child launched" rather than "non-empty" is what makes this
 * hold for a shared child: its session file holds a fork of the orchestrator's
 * branch before the pane opens, so an empty file is never the signal there. Only
 * the run's own appends past {@link RunningSubagent.sessionEntriesAtLaunch} count.
 *
 * That reading only holds for a harness that writes the session file we watch —
 * pi. A child on another harness (agy) never writes an entry at the pi-format
 * path, so silence there says nothing about whether a run started: the grace is
 * skipped for it (`RunningSubagent.writesSession`) and the wait stays on the
 * ordinary signals.
 */

import { readFileSync, rmSync } from "node:fs";
import { paneChild, type SupervisorHandle } from "../pane-host/index.ts";
import type { ResolvedProfile } from "../config/profiles.ts";
import type { ShareCost } from "./contract.ts";
import { readFailureNote, readFinalMessage, readSessionEntries } from "./session.ts";

const POLL_INTERVAL_MS = 1_000;
/** Check pane liveness every N polls — one host call per 5s, not per second. */
const PANE_CHECK_EVERY = 5;
/**
 * How long a child may go without writing a session entry of its own before the
 * run is called never-started. Generous on purpose: a cold start that writes its
 * first entry slowly is not a failure, and the answer is only terminal once the
 * file has stayed at its launch size for this long.
 */
const NEVER_STARTED_MS = 90_000;

export type FailureReason = "error" | "exit" | "no-output" | "never-started";

export type SubagentOutcome =
	/** The child handed back a result, exited pi cleanly, or an older build declared a finished turn. */
	| { kind: "completed"; via: "turn-end" | "session-exit" | "report"; summary: string | null }
	/**
	 * The process ended badly — a non-zero exit or a wrapper-written failure —
	 * or an older build declared a failed settle. The pane is deliberately left
	 * open in every case.
	 */
	| { kind: "failed"; reason: FailureReason; exitCode: number | null; summary: string | null }
	/** The pane vanished without leaving any signal. */
	| { kind: "cancelled"; summary: string | null }
	/**
	 * The wait was ended by an abort signal rather than by the child: the human
	 * stopped the turn, one Esc reached every live child, and the pane's fate then
	 * depends on why the wait was aborted. `interrupt` is the operator's own
	 * interrupt — its pane is closed by the relay that ended the wait. `shutdown`
	 * is the session going away under the wait — its pane is left open, because no
	 * relay ran and nobody is left to close it. Deliberately carries no summary —
	 * a turn stopped mid-flight has nothing to hand back, and any partial assistant
	 * text in the session is not the child's report.
	 */
	| { kind: "interrupted"; cause: "interrupt" | "shutdown" };

export interface RunningSubagent {
	id: string;
	name: string;
	agent: string | null;
	/** Resolved profile, for display only. */
	profile: ResolvedProfile | null;
	/**
	 * The pane this child owns, for the report's ``pane `x` `` line. A child
	 * supervised as a pane always has one.
	 */
	paneId: string;
	/**
	 * The supervisor that owns this child and the address it gave back. Absent
	 * when a child is described by a bare pane id alone — a fixture, or a caller
	 * that predates the supervision seam; {@link childHandle} then addresses it
	 * through the pane host.
	 */
	child?: SupervisorHandle;
	/**
	 * Whether this child's harness appends to {@link sessionFile} as it runs (pi),
	 * or keeps its transcript elsewhere (agy). The never-started grace reads that
	 * file, so it is only meaningful when the harness writes it.
	 */
	writesSession: boolean;
	sessionFile: string;
	/**
	 * Session entries the file already held when the child launched: a shared
	 * child's file starts with the fork's header and body, while an ordinary spawn's
	 * starts with no file at all. The never-started grace counts this as the
	 * baseline and reads the run as started only once the file holds more. Absent
	 * means zero — a spawn that wrote no fork had nothing to launch with.
	 */
	sessionEntriesAtLaunch?: number;
	/**
	 * What the fork cost, when this spawn shared the orchestrator's context. Absent
	 * for a child launched clean, and carried all the way to its report so the
	 * human reads the same figures the acknowledgment gave at launch.
	 */
	sharedContext?: ShareCost;
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
 * The child's report, as read from the sidecar. Current children write only
 * `{"type":"done","result":...}`; older builds could also write a content-free
 * done or a failed payload, and the reader still classifies those as before.
 *
 * A malformed file is treated as a completion rather than an error: a report
 * exists, so the child settled, and the result text comes from the session
 * either way.
 *
 * `result` is the explicit payload — present only when the child called
 * `subagent_report`. Anything that is not a non-empty string counts as
 * absent, which is what makes an old reader's output still valid input here.
 * An absent payload means no text was handed back, and the session is not asked
 * to supply one: a content-free done is a completion with no summary.
 */
interface Report {
	settle: "done" | "failed";
	/** `aborted` is parsed but is never terminal — see `classify`. */
	reason: FailureReason | "aborted";
	result: string | null;
	/**
	 * Why it failed, on a payload written by an older build — one that could
	 * declare a turn, or a prompt pi refused to start, failed. See `failure` in
	 * `classify`.
	 */
	message: string | null;
}

/** Longer than any error worth reading; a verbose one is clipped, not dropped. */
const MAX_MESSAGE = 1_000;

function readMessage(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	return trimmed.length <= MAX_MESSAGE ? trimmed : `${trimmed.slice(0, MAX_MESSAGE - 1)}…`;
}

function readReport(file: string): Report | null {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8").trim();
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { type?: unknown; reason?: unknown; result?: unknown; message?: unknown };
		if (parsed.type === "failed") {
			const reason = parsed.reason;
			return {
				settle: "failed",
				reason: reason === "aborted" || reason === "exit" || reason === "no-output" ? reason : "error",
				result: null,
				message: readMessage(parsed.message),
			};
		}
		const result =
			typeof parsed.result === "string" && parsed.result.trim() !== "" ? parsed.result : null;
		return { settle: "done", reason: "error", result, message: null };
	} catch {
		return { settle: "done", reason: "error", result: null, message: null };
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
	// An older build's failed turn carries its reason in the session, not in its
	// text. A failed payload with no turn behind it — an older build refusing a
	// prompt — carries it in the report instead, and that report leads: a message
	// was written only for the run that was ending *then*, while the session's last
	// text may be a turn from earlier (the one the user interrupted before that run
	// was refused).
	const failure = (reported: string | null) =>
		reported ?? summary() ?? readFailureNote(running.sessionFile);

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
		// drop it and keep watching. The child's next report, or its pane closing, is
		// what ends this wait — the orchestrator is never told the job closed.
		if (report.reason === "aborted") {
			remove(running.reportFile);
			return null;
		}
		// An older build's report said how the turn ended. A completed one carries
		// no text: the child's settle is terminal, not something to dress up in the
		// last sentence it happened to write. A failed one keeps its pane open — the
		// error is on screen there and the user may want to retry.
		return {
			outcome:
				report.settle === "done"
					? { kind: "completed", via: "turn-end", summary: null }
					: { kind: "failed", reason: report.reason, exitCode: null, summary: failure(report.message) },
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
			outcome: { kind: "failed", reason: "exit", exitCode: exit.code, summary: failure(null) },
			consume: [running.exitCodeFile, running.reportFile],
		};
	}

	return null;
}

/**
 * The handle a child is addressed through: the one its spawn returned, or — for
 * a child described by a bare pane id — a pane child of the pane supervisor.
 */
export function childHandle(running: RunningSubagent): SupervisorHandle {
	return running.child ?? paneChild(running.paneId);
}

/**
 * Overridable bits of the wait loop. Only tests pass these; the defaults are what
 * production uses.
 */
export interface WatcherDeps {
	/**
	 * Pane liveness probe, for a child addressed by its pane id. The default asks
	 * the child's own supervisor whether it has ended. Returns null when unknown.
	 */
	paneExists?: (paneId: string) => Promise<boolean | null>;
	pollIntervalMs?: number;
	/** Empty-session grace before a run is called never-started. */
	neverStartedMs?: number;
}

/**
 * Resolve when the subagent is finished. Never rejects, never hangs while the
 * process is alive: a pane that disappears without a signal is reported as
 * cancelled, while an abort — the tool call's turn being interrupted, or the
 * session shutting down under the wait — is reported as `interrupted`, carrying
 * which of the two it was. The two are distinct because only one of them says
 * anything about the pane: a shutdown leaves it open at the child's prompt, an
 * operator's interrupt has its pane closed by the relay.
 */
export function waitForSubagent(
	running: RunningSubagent,
	signal?: AbortSignal,
	deps: WatcherDeps = {},
): Promise<SubagentOutcome> {
	const paneExists = deps.paneExists;
	const child = childHandle(running);
	const neverStartedMs = deps.neverStartedMs ?? NEVER_STARTED_MS;

	return new Promise((resolve) => {
		let settled = false;
		let ticks = 0;
		/**
		 * Memoized positive for the never-started grace: once an entry past the launch
		 * baseline has been seen, the run happened and this file never needs parsing
		 * again. The negative has to be re-read — an entry can still appear.
		 */
		let startedRun = false;

		const finish = (outcome: SubagentOutcome, consume: string[] = []): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
			for (const file of consume) remove(file);
			resolve(outcome);
		};

		const onAbort = (): void => {
			// No summary is read here, not even from a session that holds partial
			// assistant text: an interrupted turn was cut off, and half an answer is not
			// a result the child handed back. Only the reason the wait was aborted is
			// recorded, because it decides whether the pane is closed or left open.
			finish({ kind: "interrupted", cause: signal?.reason === "shutdown" ? "shutdown" : "interrupt" });
		};

		const check = async (): Promise<void> => {
			if (settled) return;

			const classification = classify(running);
			if (classification) {
				finish(classification.outcome, classification.consume);
				return;
			}

			// No signal, and nothing written since launch: a prompt pi refused never
			// starts a run, so an unchanged session file is the only trace it leaves.
			// The pane stays open — a human can still fix the credential and drive it on.
			// Only a harness that writes this file can be read this way: for any other
			// the unchanged file is the normal state of a healthy run.
			const graceElapsed = Date.now() - running.startedAt >= neverStartedMs;
			if (running.writesSession && !startedRun && graceElapsed) {
				startedRun = readSessionEntries(running.sessionFile).length > (running.sessionEntriesAtLaunch ?? 0);
				if (!startedRun) {
					// A report can land between `classify` and here. It is the child's own
					// word, so it outranks the inference; the next tick reads it properly.
					if (readReport(running.reportFile) !== null) return;
					finish({ kind: "failed", reason: "never-started", exitCode: null, summary: null });
					return;
				}
			}

			ticks += 1;
			if (ticks % PANE_CHECK_EVERY !== 0) return;

			// No signal yet. If the child itself is over, nothing more will arrive.
			const over = paneExists
				? (await paneExists(running.paneId)) === false
				: (await child.supervisor.ended(child)) === true;
			if (over) {
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
