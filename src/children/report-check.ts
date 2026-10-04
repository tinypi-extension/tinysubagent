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
 * choice SystemOne already makes for routing — so the same transport
 * and the same credentials make the call here: the final message goes
 * in as the task, the two verdicts go in as the criteria, and the
 * choice the chooser returns is the verdict. A decision that cannot be
 * made (no credentials, a transport failure, an answer this code does
 * not know) means "leave it alone": the child then behaves exactly as
 * it did before this check existed.
 */

import type { SystemOneConfig } from "../config/config.ts";
import { routeOnce, type RouteOnceDeps } from "../systemone/client.ts";

/** Identity the chooser sees for this decision. */
export const REPORT_CHECK_ROLE = {
	name: "report-check",
	description:
		"Decides whether a subagent that ended its turn without calling subagent_report had finished its work, or was not done yet.",
};

/** The chooser's two verdicts, keyed by the answer it returns. */
export const REPORT_CHECK_CRITERIA: Record<string, string> = {
	forgotten:
		"The subagent completed its task. Its final message is a finished result it never handed back — it should be reminded to call subagent_report.",
	"not-finished":
		"The subagent is not finished: it asked a question, needs input, hit a limit, or is still working. It should be left alone.",
};

/** The verdict that means "remind the model to report". */
export const FORGOTTEN = "forgotten";

/** Cap on the decision payload: enough prose to judge, small enough to stay cheap. */
export const MAX_CHECK_MESSAGE = 4_000;

/** Clip a final message to the decision payload cap. */
export function clipMessage(message: string): string {
	return message.length <= MAX_CHECK_MESSAGE
		? message
		: `${message.slice(0, MAX_CHECK_MESSAGE - 1)}…`;
}

/**
 * True when the final message is a finished result the model never
 * reported. Never throws: every failure lands on `false`, the verdict
 * that changes nothing.
 */
export async function checkReport(
	message: string,
	systemOne: SystemOneConfig,
	deps: RouteOnceDeps = {},
): Promise<boolean> {
	try {
		const outcome = await routeOnce(
			{
				apiKey: systemOne.apiKey,
				baseUrl: systemOne.baseUrl,
				model: systemOne.model,
				task: clipMessage(message),
				role: REPORT_CHECK_ROLE,
				criteria: REPORT_CHECK_CRITERIA,
			},
			deps,
		);
		return outcome?.choice === FORGOTTEN;
	} catch {
		// The transport promises not to throw; this backstop makes the
		// promise airtight, and a broken decision must not break the child.
		return false;
	}
}
