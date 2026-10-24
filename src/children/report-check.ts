/**
 * Report-check decision: did the subagent finish, and forget to say so?
 *
 * A turn can end without `subagent_report` for two very different
 * reasons: the model completed its work and simply never made the
 * call (the common case — the brief asked for a tool, the model
 * answered in prose instead), or it is not finished at all (it asked
 * a question back, needs input, or ran out of room). The first wants
 * a nudge; the second wants to be left alone, because a reminder is
 * just another turn for a model that has nothing to report.
 *
 * Telling those apart is a judgment about prose — exactly the kind of
 * choice routing already makes — so the configured routing transport
 * makes the call here. That is the in-process classifier when
 * `classifierModel` is set, otherwise the legacy SystemOne endpoint.
 * The final message goes in as the task, the two verdicts go in as the
 * criteria, and the choice that comes back is the verdict. A decision
 * that cannot be made (no transport configured, a transport failure, an
 * answer this code does not know) means "leave it alone": the child then
 * behaves exactly as it did before this check existed.
 */

import type { TinysubagentConfig } from "../config/config.ts";
import { createRouteFn, type ClassifierRegistry, type RouteFn } from "../systemone/route.ts";

/** Identity the chooser sees for this decision. */
export const REPORT_CHECK_ROLE = {
	name: "report-check",
	description:
		"Decides whether a subagent that ended its turn without calling subagent_report had finished its work, or was not done yet.",
};

/** The verdict that means "remind the model to report". */
export const FORGOTTEN = "forgotten";

/** The verdict that means "this child has nothing to hand back yet". */
export const NOT_FINISHED = "not-finished";

/** The chooser's two verdicts, keyed by the answer it returns. */
export const REPORT_CHECK_CRITERIA: Record<string, string> = {
	[FORGOTTEN]:
		"The subagent completed its task. Its final message is a finished result it never handed back — it should be reminded to call subagent_report.",
	[NOT_FINISHED]:
		"The subagent is not finished: it asked a question, needs input, hit a limit, or is still working. It should be left alone.",
};

/**
 * What the check concluded. `unknown` is every non-answer — no transport, a
 * failed transport, an answer this code does not recognise — and it carries the
 * reason so the line the user reads can say why nothing happened.
 */
export type ReportCheck =
	| { verdict: typeof FORGOTTEN }
	| { verdict: typeof NOT_FINISHED }
	| { verdict: "unknown"; reason: string };

/** The question the classifier answers for this decision. */
export const REPORT_CHECK_INSTRUCTIONS =
	"Decide whether the subagent's final message is a finished result it never handed " +
	"back over `subagent_report`, or whether it is not finished. Answer with exactly one " +
	"of the criterion keys.";

/** Cap on the decision payload: enough prose to judge, small enough to stay cheap. */
export const MAX_CHECK_MESSAGE = 4_000;

/** Clip a final message to the decision payload cap. */
export function clipMessage(message: string): string {
	return message.length <= MAX_CHECK_MESSAGE
		? message
		: `${message.slice(0, MAX_CHECK_MESSAGE - 1)}…`;
}

/** The line the user sees while the decision is in flight. */
export function checkingLine(message: string): string {
	return `report-check: asking the classifier (${clipMessage(message).length} chars)…`;
}

/** The line the user sees once the decision lands, whatever it landed on. */
export function checkLine(check: ReportCheck): string {
	switch (check.verdict) {
		case FORGOTTEN:
			return "report-check: forgotten → reminding the subagent to call subagent_report";
		case NOT_FINISHED:
			return "report-check: not-finished → leaving the child alone";
		default:
			return `report-check: no verdict (${check.reason}) → leaving the child alone`;
	}
}

/**
 * The production decider: builds the routing transport once from the loaded
 * config, then asks it for each unreported settle. The registry is the child's
 * own pi model registry, which the in-process classifier needs.
 */
export function createReportDecider(
	config: TinysubagentConfig,
	registry?: ClassifierRegistry,
): (message: string) => Promise<ReportCheck> {
	// Nothing to ask: routing is off, and the user is told so instead of watching
	// a check that was never going to reach a model.
	if (config.classifier === null && config.systemOne === null) {
		return async () => ({ verdict: "unknown", reason: "no routing transport configured" });
	}
	const route = createRouteFn(config, { registry });
	return (message: string) => inspectReport(message, route);
}

/**
 * The full answer: which verdict the transport returned, or why it returned
 * none. Never throws — the transport's failures become the `unknown` verdict.
 */
export async function inspectReport(message: string, route: RouteFn): Promise<ReportCheck> {
	try {
		const outcome = await route({
			agent: REPORT_CHECK_ROLE,
			task: clipMessage(message),
			criteria: REPORT_CHECK_CRITERIA,
			instructions: REPORT_CHECK_INSTRUCTIONS,
		});
		if (outcome?.choice === FORGOTTEN) return { verdict: FORGOTTEN };
		if (outcome?.choice === NOT_FINISHED) return { verdict: NOT_FINISHED };
		return {
			verdict: "unknown",
			reason:
				typeof outcome?.choice === "string" && outcome.choice !== ""
					? `unrecognised verdict "${outcome.choice}"`
					: "the transport returned no verdict",
		};
	} catch {
		// The transport promises not to throw; this backstop makes the promise
		// airtight, and a broken decision must not break the child.
		return { verdict: "unknown", reason: "the check threw" };
	}
}

/**
 * True when the final message is a finished result the model never
 * reported. Never throws: every failure lands on `false`, the verdict
 * that changes nothing.
 */
export async function checkReport(message: string, route: RouteFn): Promise<boolean> {
	return (await inspectReport(message, route)).verdict === FORGOTTEN;
}
