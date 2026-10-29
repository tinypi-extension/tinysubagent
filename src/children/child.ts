/**
 * Child-side extension, loaded into every subagent with `-e <this file>`.
 *
 * Its whole job is to answer one question for the orchestrator: *is this
 * subagent finished?* The only answer it ever gives is `subagent_report`, the
 * explicit hand-back: the child decides it is done and passes its complete
 * result as an argument, so the orchestrator receives exactly that text instead
 * of inferring it from a session it has to scrape. The call writes a single
 * sidecar file — `$PI_TINYSUBAGENT_REPORT` — and shuts its own pi down, which
 * ends the wrapper script, which lets the pane close itself.
 *
 * ## A settle is not an ending
 *
 * `agent_settled` firing means the agent loop drained, not that the child
 * finished. No settle writes a sidecar and no settle shuts the child down: the
 * child stays at its interactive prompt with its whole context intact. The
 * watcher already treats "no sidecar, no exit code, pane alive" as "keep
 * waiting", so the orchestrator's batch holds until a human asks the child for
 * the report in its pane, quits it, or closes it.
 *
 * That is what makes every non-report ending recoverable: a provider outage, an
 * expired credential, a bad model, exhausted retries, an interrupt, or a turn
 * that produced no assistant message at all — all leave the same live child at
 * its prompt. The human fixes what went wrong, drives the child on, and its
 * eventual `subagent_report` lands as the result. Reporting the failure instead
 * — the old `failed (error)` sidecar — ended the batch while the pane stayed
 * open, so the eventual report had nowhere to land.
 *
 * ## Why `agent_settled` and not `agent_end`
 *
 * `agent_end` fires once per agent phase, and pi may follow it with an automatic
 * retry, an auto-compaction, or a queued continuation — so acting there would
 * mistake a retry for the end of the turn. `agent_settled` fires exactly once,
 * from a `finally`, after all of that has drained: it means nothing else will
 * run until the human or a steer starts another turn.
 *
 * ## What an interrupt is
 *
 * Pressing Esc in the child's pane unwinds the agent loop, so `agent_settled`
 * fires — but the child has not finished: it is alive at its prompt, one
 * keystroke away from being redirected, which is exactly why the user pressed
 * Esc. An interrupted settle therefore writes nothing, and the watcher keeps
 * watching the pane for the child's next real settle.
 *
 * Esc is not reliably *labelled* as an interrupt: one that lands while a tool
 * call is running is filed by pi as a plain `error` — "This operation was
 * aborted" — indistinguishable from a real failure by stop reason. It does not
 * need telling apart: every non-clean settle is silence now, so the tool-call
 * Esc and the provider error take the same path and there is no abort signal to
 * capture or trust.
 *
 * ## The turn that ended without a report
 *
 * A turn that finished cleanly with no report behind it means the model answered
 * in prose instead of calling `subagent_report`. The child is staying open
 * anyway, so before it goes quiet it steers itself a reminder to make the call,
 * which starts one more turn in which the model can still hand its result back.
 * A model that keeps forgetting is reminded at most `MAX_REPORT_REMINDERS`
 * times. The nudge goes out at once, on the strength of there being a final
 * message at all; the child never decides what an unreported turn ended with.
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

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { REPORT_TOOL_NAME } from "../types.ts";
import { writeReportFile, writeResultReport } from "./report.ts";
import { readFinalMessage } from "./session.ts";
import { finishedCleanly } from "./settle.ts";
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
 * Overridable bits of the child, so tests can answer the one question
 * the reminder needs without a session file.
 */
export interface ChildDeps {
	/** The child's final assistant message, or null when it wrote none. */
	readFinal?: () => string | null;
}

export default function tinysubagentChild(pi: ExtensionAPI, deps: ChildDeps = {}): void {
	/** Messages from the most recent agent phase; the settle decides on these. */
	let lastMessages: TurnMessage[] | undefined;
	/** Set once the child has reported success and begun shutting down. */
	let finished = false;
	/** Reminders sent for unreported turn ends; capped by MAX_REPORT_REMINDERS. */
	let remindersSent = 0;

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

	pi.on("agent_end", (event) => {
		lastMessages = event.messages as unknown as TurnMessage[];
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

	pi.on("agent_settled", async () => {
		if (finished) return;

		// No settle is an ending: the child stays alive at its prompt with its
		// context intact, and the watcher keeps waiting. Every non-clean ending —
		// a provider error, a tool-call Esc that pi labels an error, a labelled
		// interrupt, a turn with no assistant message — takes this same silent path.
		// The human resolves the pane: fix the provider and drive the child on,
		// `/quit`, or close it.
		if (!finishedCleanly(lastMessages)) return;

		// The one thing worth doing with that wait: a model that finished its work
		// in prose instead of making the call can still be nudged into it. The pane
		// was staying open anyway.
		await remindIfUnreported();
	});

	/**
	 * Nudge a finished result that was never reported. The turn has ended, so
	 * the child is idle: a steer starts one more turn, in which the model can
	 * make the call it skipped. The nudge goes out at once, on the strength of
	 * there being a final message at all.
	 */
	async function remindIfUnreported(): Promise<void> {
		if (remindersSent >= MAX_REPORT_REMINDERS) return;
		const finalMessage = deps.readFinal ? deps.readFinal() : finalSessionMessage();
		if (finalMessage === null) return;

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
