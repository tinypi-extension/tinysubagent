/**
 * Child-side extension, loaded into every subagent with `-e <this file>`.
 *
 * Its whole job is to answer one question for the orchestrator: *is this
 * subagent finished, and did it finish well?* It answers by writing a single
 * sidecar file — `$PI_TINYSUBAGENT_REPORT` — and then shutting its own pi down,
 * which ends the wrapper script, which lets the pane close itself.
 *
 * Two paths write that sidecar and they are both load-bearing:
 *
 *  - `subagent_report`, the explicit hand-back. The child decides it is done
 *    and passes its complete result as an argument, so the orchestrator receives
 *    exactly that text instead of inferring it from a session it has to scrape.
 *  - the settle hook, the fallback. A child that never calls the tool, or whose
 *    call could not be written, still stamps a content-free `{"type":"done"}`
 *    when its turn settles, and the orchestrator reads the result from the
 *    session as it always has.
 *
 * The tool is the better path because it needs no scrape and no drained turn;
 * the settle report is the one that guarantees the orchestrator can never hang.
 *
 * ## Why `agent_settled` and not `agent_end`
 *
 * `agent_end` fires once per agent phase, and pi may follow it with an automatic
 * retry, an auto-compaction, or a queued continuation — so acting there reports
 * a retry as a result. `agent_settled` fires exactly once, from a `finally`,
 * after all of that has drained: it means nothing else will run.
 *
 * That has three consequences worth stating, because they are the reason this
 * file is short:
 *
 *  - a transient error that pi retries is never mistaken for a failure;
 *  - a message the user steers into the pane is allowed to finish first;
 *  - every *finished* settle produces a report, so an orchestrator waiting on a
 *    batch can never be left hanging by a child that stopped but stayed open.
 *
 * ## What an interrupt is
 *
 * The third point has one deliberate exception. Pressing Esc in the child's pane
 * unwinds the agent loop, so `agent_settled` fires — but the child has not
 * finished: it is alive at its prompt, one keystroke away from being redirected,
 * which is exactly why the user pressed Esc. Reporting that as an ending is what
 * used to tell the orchestrator that a job the user was still steering had
 * closed. An interrupted settle therefore writes nothing at all, and the watcher
 * keeps watching the pane for the child's next real settle.
 *
 * Esc is not reliably *labelled* as an interrupt, which is the trap here. One that
 * lands while a tool call is running is filed by pi as a plain `error` — "This
 * operation was aborted" — which no stop reason can tell apart from a real
 * failure. The run's abort signal is the honest record: it is captured while the
 * run is still live and stays set once the run is over, so the settle trusts it
 * over the label.
 *
 * ## What a failure does *not* do
 *
 * A failed settle reports the failure and then leaves pi running. An interactive
 * pi renders an error and waits at the prompt rather than exiting, and that is
 * worth preserving: the user can read the error, retry, or steer the child. The
 * orchestrator is told the child failed; the pane stays up until the user is
 * done with it.
 *
 * ## The run that never started
 *
 * One failure is not a settle, because no run happened: pi validates the selected
 * model and the provider's credentials inside `prompt()` and *throws* before the
 * agent phase begins when either is missing — "No API key found for oc-openai"
 * being the common one. No run means no `agent_end` and no `agent_settled`, so
 * none of the above runs, and the watcher waits forever on a child that is
 * sitting at its prompt having done nothing. That is a hung batch with nothing
 * on screen to explain it.
 *
 * The `input` hook is the one place that can see this coming: it fires inside the
 * same `prompt()` call, immediately before the validation. So the child repeats
 * pi's preflight — the cheap configured check, then the provider lookup pi would
 * fall back to — and, when both come back empty, reports the failure itself,
 * carrying the reason, because pi never wrote a turn to read it back from.
 *
 * The run is the only thing skipped: the child stays alive at its prompt, which
 * is where the user runs `/login` and retries. Reporting is what keeps the
 * orchestrator from waiting on a child that cannot start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeReportFile, writeResultReport } from "./report.ts";
import { failureDetail, settleReason } from "./settle.ts";
import type { TurnMessage } from "./settle.ts";
import { errorText, preflightFailure, preflightRefusal } from "./preflight.ts";
import { REPORT_TOOL_NAME } from "../types.ts";

export default function tinysubagentChild(pi: ExtensionAPI): void {
	/** Messages from the most recent agent phase; the settle decides on these. */
	let lastMessages: TurnMessage[] | undefined;
	/** Set once the child has reported success and begun shutting down. */
	let finished = false;
	/** Abort signal of the run that just ended; see where it is captured and why. */
	let runSignal: AbortSignal | undefined;

	// The explicit hand-back: the model passes its result, this writes it, and
	// the orchestrator delivers that exact text. Automatic completion at settle
	// does not depend on it — that is the fallback for a child that never calls.
	pi.registerTool({
		name: REPORT_TOOL_NAME,
		label: "Subagent Report",
		description:
			"Finish this subagent and hand your result back to the agent that spawned you. " +
			"Pass the complete result text — not a summary of where to find it. Calling this " +
			"closes the pane.",
		parameters: Type.Object({
			result: Type.String({
				description:
					"Your complete result — the full text the caller receives, not a pointer to it.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (finished) {
				return { content: [{ type: "text" as const, text: "Result already reported." }], details: {} };
			}
			if (!writeResultReport(params.result)) {
				// Stay alive rather than exiting with the result unreported: the model
				// can retry, or simply finish and let the settle path carry it.
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Could not report the result — the sidecar write failed. It has NOT been " +
								"delivered. Finish your turn normally and the caller will read your final " +
								"message instead.",
						},
					],
					details: {},
				};
			}
			finished = true;
			ctx.shutdown();
			return { content: [{ type: "text" as const, text: "Result reported." }], details: {} };
		},
	});

	pi.on("agent_end", (event, ctx) => {
		lastMessages = event.messages as unknown as TurnMessage[];
		// Captured here and not at settle time, because pi clears the agent's active
		// run — and with it `ctx.signal` — before `agent_settled` fires. An aborted
		// signal stays aborted, so the answer is still there to be read later.
		runSignal = ctx.signal;
	});

	// pi throws out of `prompt()` when the model or its credentials are missing,
	// and a run that never started settles nothing — so the failure would go
	// unreported and the orchestrator would wait on an idle child forever. The
	// input hook runs inside that same `prompt()` call, just before the check, so
	// this is the only place able to report it.
	pi.on("input", async (_event, ctx) => {
		if (finished) return;
		// A steer arriving mid-run is not a refusal: pi queues it, and the run it
		// joins reports for itself when it settles.
		if (!ctx.isIdle()) return;

		let refusal: string | null;
		try {
			refusal = await preflightRefusal(ctx);
		} catch (error) {
			// pi swallows a hook that throws, so an unexpected one here would be the
			// same silence this hook exists to break. Report it rather than lose it.
			refusal = preflightFailure({
				provider: ctx.model?.provider ?? null,
				usesOAuth: false,
				cause: errorText(error),
			});
		}
		// The lookup above awaits: a report may have landed while it ran.
		if (finished) return;
		if (refusal === null) return;

		writeReportFile("failed", "error", refusal);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (finished) return;

		const settle = settleReason(lastMessages);
		if (settle === "done") {
			// Best-effort write: the pane must close either way, or the orchestrator
			// waits forever on a child that stopped but stayed open.
			writeReportFile("done");
			finished = true;
			ctx.shutdown();
			return;
		}

		// The user Esc'd this child to redirect it. The loop unwound, but the child did
		// not finish — it is alive at its prompt, so there is no ending to report, and
		// a sidecar here is precisely what used to close the orchestrator's batch under
		// the user's feet. Staying silent leaves the watcher watching this pane.
		//
		// The signal is what actually identifies the interrupt, because the stop reason
		// cannot: an Esc that landed on a tool call reaches us as a plain `error`. Both
		// checks mean the same thing — the signal covers the tool call, the verdict
		// covers an abort pi did label.
		if (runSignal?.aborted === true || settle === "interrupted") return;

		// Report the failure but stay alive: an errored interactive pi is sitting
		// at its prompt, and the user may want to read it, retry, or steer.
		writeReportFile("failed", failureDetail(lastMessages));
	});
}
