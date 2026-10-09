/**
 * Child-side extension, loaded into every subagent with `-e <this file>`.
 *
 * Its whole job is to answer one question for the orchestrator: *is this
 * subagent finished, and did it finish well?* It answers by writing a single
 * sidecar file — `$PI_TINYSUBAGENT_REPORT` — and then shutting its own pi down,
 * which ends the wrapper script, which lets the pane close itself.
 *
 * The only path that writes the success sidecar is `subagent_report`, the
 * explicit hand-back: the child decides it is done and passes its complete
 * result as an argument, so the orchestrator receives exactly that text instead
 * of inferring it from a session it has to scrape. The call shuts the child's
 * pi down, which is what closes the pane.
 *
 * ## An unreported turn end is not an ending
 *
 * A child whose turn settles as `done` without a prior `subagent_report` writes
 * nothing and keeps running: it sits at its interactive prompt with its whole
 * context intact. The watcher already treats "no sidecar, no exit code, pane
 * alive" as "keep waiting", so the orchestrator's batch holds until a human
 * asks the child for the report in its pane, quits it, or closes it. Writing a
 * content-free `done` and shutting down instead — the old fallback — is what
 * used to close a pane the human was told to inspect, destroying the only copy
 * of the child's context with it.
 *
 * ## Why `agent_settled` and not `agent_end`
 *
 * `agent_end` fires once per agent phase, and pi may follow it with an automatic
 * retry, an auto-compaction, or a queued continuation — so acting there reports
 * a retry as a result. `agent_settled` fires exactly once, from a `finally`,
 * after all of that has drained: it means nothing else will run.
 *
 * That has consequences worth stating, because they are the reason this
 * file is short:
 *
 *  - a transient error that pi retries is never mistaken for a failure;
 *  - a message the user steers into the pane is allowed to finish first;
 *  - an interrupted settle is not an ending (see below), and neither is an
 *    unreported `done` — silence in both cases leaves the watcher watching the
 *    pane for the child's next real settle.
 *
 * ## What an interrupt is
 *
 * Pressing Esc in the child's pane unwinds the agent loop, so `agent_settled`
 * fires — but the child has not finished: it is alive at its prompt, one
 * keystroke away from being redirected, which is exactly why the user pressed
 * Esc. Reporting that as an ending is what used to tell the orchestrator that a
 * job the user was still steering had closed. An interrupted settle therefore
 * writes nothing at all, and the watcher keeps watching the pane for the
 * child's next real settle.
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
 * A settle whose messages contain no assistant message at all is a special
 * case of the silence: the turn produced nothing reportable and the child is
 * still alive at its prompt, so writing the `no-output` failure and holding the
 * batch on a `failed` verdict would describe a child the user can simply steer
 * into working. Silence here means the same thing it means for an interrupt —
 * the watcher keeps waiting, and the human resolves the pane.
 *
 * ## The turn that ended without a report
 *
 * A `done` settle with no report behind it means the model answered in
 * prose instead of calling `subagent_report`. The child was staying open
 * anyway, so before it goes quiet it asks the configured routing
 * transport — the same chooser routing uses — whether that final
 * message is a finished result. When it is, the child steers itself a
 * reminder to make the call, which starts one more turn in which the
 * model can still hand its result back. A model that keeps forgetting
 * is reminded at most `MAX_REPORT_REMINDERS` times, and a model that was
 * never finished (a question back, a request for input) is left alone:
 * a reminder there would just spend a turn. No credentials, a failed
 * decision, or an unknown answer all mean "leave it alone" too — the
 * child then behaves exactly as it did before this check existed.
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

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../config/config.ts";
import type { ClassifierRegistry } from "../systemone/route.ts";
import { REPORT_TOOL_NAME } from "../types.ts";
import { createReportDecider } from "./report-check.ts";
import { writeReportFile, writeResultReport } from "./report.ts";
import { readFinalMessage } from "./session.ts";
import { failureDetail, settleReason } from "./settle.ts";
import type { TurnMessage } from "./settle.ts";
import { errorText, preflightFailure, preflightRefusal } from "./preflight.ts";

/** How many times one child may be nudged to report before it is left alone. */
export const MAX_REPORT_REMINDERS = 2;

/** The nudge itself: a steer, so the model sees why it is being asked again. */
const REPORT_REMINDER =
	"Your last turn ended with what looks like a complete result, but you " +
	"never called `" +
	REPORT_TOOL_NAME +
	"`. Call `" +
	REPORT_TOOL_NAME +
	"` now with your full result in the `result` argument — that call is " +
	"what delivers it to the caller and closes this pane. Ending your turn " +
	"without it sends nothing.";

/**
 * Overridable bits of the child, so tests can answer the two questions
 * the reminder needs without a SystemOne endpoint or a session file.
 */
export interface ChildDeps {
	/** The child's final assistant message, or null when it wrote none. */
	readFinal?: () => string | null;
	/** Whether that message is a finished result the model never reported. */
	decidesReport?: (message: string) => Promise<boolean>;
}

export default function tinysubagentChild(pi: ExtensionAPI, deps: ChildDeps = {}): void {
	/** Messages from the most recent agent phase; the settle decides on these. */
	let lastMessages: TurnMessage[] | undefined;
	/** Set once the child has reported success and begun shutting down. */
	let finished = false;
	/** Abort signal of the run that just ended; see where it is captured and why. */
	let runSignal: AbortSignal | undefined;
	/** Reminders sent for unreported turn ends; capped by MAX_REPORT_REMINDERS. */
	let remindersSent = 0;
	/** The report-check decider, built once on the first unreported settle. */
	let reportDecider: ((message: string) => Promise<boolean>) | undefined;

	// The explicit hand-back: the model passes its result, this writes it, and
	// the orchestrator delivers that exact text. This is the only path that
	// closes the pane on success — a turn that ends without it keeps the pane
	// open, so a failed write here means the model must retry the call.
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
				// must retry the call, because there is no settle fallback to carry
				// the result anymore — an unreported turn end just keeps the pane open.
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Could not report the result — the sidecar write failed. It has NOT been " +
								"delivered. Call `subagent_report` again with the same result; the pane " +
								"stays open and the caller keeps waiting until the report succeeds.",
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

	pi.on("agent_settled", async (_event, ctx) => {
		if (finished) return;

		// An unreported turn end is not an ending: the child stays alive at its
		// prompt with its context intact, and the watcher keeps waiting. Writing a
		// content-free `done` and shutting down here is what used to close a pane
		// the human was told to inspect. The batch holds until a human asks for
		// the report, quits the child, or closes the pane.
		const settle = settleReason(lastMessages);
		if (settle === "done") {
			// The one thing worth doing with that wait: a model that finished its
			// work in prose instead of making the call can still be nudged into
			// it. The pane was staying open anyway.
			await remindIfUnreported(ctx);
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

		// A settle with no assistant message at all is also silence, not a failure:
		// nothing reportable was produced and the child is still alive at its
		// prompt. Reporting `no-output` would mark the batch failed for a child the
		// user can simply steer into working, so it waits like an interrupt does.
		// A real `error` stop reason still reports below — that one is a failure.
		if (failureDetail(lastMessages) === "no-output") return;

		// Report the failure but stay alive: an errored interactive pi is sitting
		// at its prompt, and the user may want to read it, retry, or steer.
		writeReportFile("failed", failureDetail(lastMessages));
	});

	/**
	 * Nudge a finished result that was never reported. The turn has ended, so
	 * the child is idle: a steer starts one more turn, in which the model can
	 * make the call it skipped.
	 */
	async function remindIfUnreported(ctx: ExtensionContext): Promise<void> {
		if (remindersSent >= MAX_REPORT_REMINDERS) return;
		const finalMessage = deps.readFinal ? deps.readFinal() : finalSessionMessage();
		if (finalMessage === null) return;
		if (reportDecider === undefined) {
			reportDecider =
				deps.decidesReport ??
				productionDecider(ctx.modelRegistry as unknown as ClassifierRegistry);
		}

		let remind = false;
		try {
			remind = await reportDecider(finalMessage);
		} catch {
			// A broken decider must not break the settle; leave the child as it is.
			remind = false;
		}
		if (!remind) return;

		remindersSent += 1;
		pi.sendMessage(
			{
				customType: "tinysubagent_report_reminder",
				content: REPORT_REMINDER,
				display: true,
				details: {},
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}
}

/**
 * The child's own final assistant message, read from the session file pi is
 * already appending to — the same file the orchestrator later reads a
 * result back from.
 */
function finalSessionMessage(): string | null {
	const file = process.env.PI_TINYSUBAGENT_SESSION;
	return file === undefined ? null : readFinalMessage(file);
}

/**
 * The production decider: the configured routing transport judges the message,
 * the same one routing uses. Config is read and the decider built on
 * the first unreported settle — a child that always reports never pays for the
 * lookup. The registry is the child's own, which the in-process classifier needs.
 */
function productionDecider(registry: ClassifierRegistry): (message: string) => Promise<boolean> {
	let decide: ((message: string) => Promise<boolean>) | undefined;
	return async (message: string): Promise<boolean> => {
		decide ??= createReportDecider(loadConfig(process.cwd(), getAgentDir()).config, registry);
		return decide(message);
	};
}
