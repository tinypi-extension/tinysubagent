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
 * launched with, of any role, mean a run happened and the ordinary rules apply.
 *
 * What the report then says about the remedy depends on where the child is
 * running: under a pane host the pane is deliberately left open, because `/login`
 * in it is still the fix; a plain child has no pane to leave open, so its report
 * carries the instruction instead (`emptySummaryText` in `present/result.ts`).
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
	 *
	 * `stderr` is the tail of the child's own stderr, present only where the child
	 * had a stream of its own to write it to — the evidence a human used to read
	 * off a crashed pane. Absent, not empty, when there is nothing to quote, so
	 * every other failure keeps the shape it always had.
	 */
	| { kind: "failed"; reason: FailureReason; exitCode: number | null; summary: string | null; stderr?: string }
	/**
	 * The pane vanished without leaving any signal. A statement about a pane, so it
	 * needs one: a plain child's death is read from its process instead, and a
	 * pane-less child can therefore never carry this outcome.
	 */
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
	 * supervised as a pane always has one; a child supervised as a process has no
	 * pane identity at all, and no label stands in for it.
	 */
	paneId?: string;
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
			// Under a pane host the work that happened is still worth returning, and
			// the session is where it is read. A plain child has no pane the summary
			// would lead back to, so the same ending is content-free there: nothing it
			// wrote is the report, and nothing is scraped to invent one.
			return {
				outcome: {
					kind: "completed",
					via: "session-exit",
					summary: running.paneId === undefined ? null : summary(),
				},
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
 * Null only when a child has neither, which a spawn never produces: every child
 * is opened through a supervisor and keeps its handle.
 */
export function childHandle(running: RunningSubagent): SupervisorHandle | null {
	if (running.child) return running.child;
	return running.paneId === undefined ? null : paneChild(running.paneId);
}

/**
 * How a plain child ended when its process is gone and no sidecar explains it.
 *
 * The wrapper writes its exit-code sidecar before it exits, so a child whose
 * process is gone and whose sidecar is missing was killed before it could write
 * one — an OOM kill, a SIGKILL of the shell. Its own captured status is then the
 * only reading left, and a status this kind could not capture (a death by
 * signal) is still an ending: the wait reports the failure instead of waiting
 * for a sidecar that will never land.
 *
 * No summary is read from the session here. A plain child that exits without
 * reporting is the content-free completion: the work happened, and nothing it
 * wrote is the report.
 */
function processEnding(child: SupervisorHandle): SubagentOutcome {
	const code = child.supervisor.exitCode?.(child) ?? null;
	return code === 0
		? { kind: "completed", via: "turn-end", summary: null }
		: { kind: "failed", reason: "exit", exitCode: code, summary: null };
}

/**
 * The stderr a failure can quote, read from the child's own supervisor at the
 * moment it is classified.
 *
 * Only a kind that gives a child a stream of its own has any, and only a failure
 * wants it: a report is the child's word, an interrupt the human's, and neither
 * needs a forensic tail. Nothing here is scraped — the text is what the child
 * wrote, kept while it wrote it.
 */
function failureEvidence(running: RunningSubagent): string | undefined {
	const child = childHandle(running);
	if (child === null) return undefined;
	const tail = child.supervisor.stderr?.(child) ?? "";
	return tail === "" ? undefined : tail;
}

/**
 * Overridable bits of the wait loop. Only tests pass these; the defaults are what
 * production uses.
 */
export interface WatcherDeps {
	/**
	 * Pane liveness probe, for a child addressed by its pane id. The default asks
	 * the child's own supervisor whether its pane has ended. Without a pane id
	 * there is no pane to probe: a process's end is read from the process itself,
	 * through its supervisor. Returns null when unknown.
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
 *
 * A child with no pane has no cancellation to reach: a process that dies is its
 * own ending, so `cancelled` is a pane host's outcome alone.
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

			// A failure is the one ending a child's own stderr is evidence for: it is
			// where a crash, or a prompt pi refused before any run, says why. The tail
			// rides with the outcome so it reaches the report, and only ever on a
			// failure — a completion hands back words, and an interrupt hands back none.
			const evidenced = (outcome: SubagentOutcome): SubagentOutcome => {
				if (outcome.kind !== "failed") return outcome;
				const stderr = failureEvidence(running);
				return stderr === undefined ? outcome : { ...outcome, stderr };
			};

			const classification = classify(running);
			if (classification) {
				finish(evidenced(classification.outcome), classification.consume);
				return;
			}

			// No signal, and nothing written since launch: a prompt pi refused never
			// starts a run, so an unchanged session file is the only trace it leaves.
			// A pane child is left at its prompt so a human can still fix the credential
			// and drive it on; a pane-less one is given the same instruction in its
			// report instead, because there is nobody to type into it.
			// Only a harness that writes this file can be read this way: for any other
			// the unchanged file is the normal state of a healthy run.
			const graceElapsed = Date.now() - running.startedAt >= neverStartedMs;
			if (running.writesSession && !startedRun && graceElapsed) {
				startedRun = readSessionEntries(running.sessionFile).length > (running.sessionEntriesAtLaunch ?? 0);
				if (!startedRun) {
					// A report can land between `classify` and here. It is the child's own
					// word, so it outranks the inference; the next tick reads it properly.
					if (readReport(running.reportFile) !== null) return;
					finish(evidenced({ kind: "failed", reason: "never-started", exitCode: null, summary: null }));
					return;
				}
			}

			// No signal yet. A pane child whose pane is gone has nothing more to
			// arrive, and so does a plain child whose process is gone: both are read
			// from the child's own supervisor, and only the ending differs.
			if (running.paneId === undefined) {
				// A process that dies is not a cancellation — nothing vanished, the work
				// simply stopped — and its death is not left to the sidecar alone: a
				// wrapper killed before it could write one would hang the batch for the
				// life of this process. A sidecar, when there is one, was already read by
				// `classify` above and wins; this is the fallback for the death that left
				// none. A local flag, so it is cheap enough to read every tick.
				if (child === null || (await child.supervisor.ended(child)) !== true) return;
				finish(evidenced(processEnding(child)));
				return;
			}

			ticks += 1;
			if (ticks % PANE_CHECK_EVERY !== 0) return;

			// Pane liveness costs a host subprocess, so it is read far less often.
			const over = paneExists !== undefined
				? (await paneExists(running.paneId)) === false
				: child !== null && (await child.supervisor.ended(child)) === true;
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
