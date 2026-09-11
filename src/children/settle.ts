/**
 * Settle classification: what a run's end means and the reason to record.
 *
 * At settle time the run is over whatever the stop reason says, so only the two
 * genuinely bad endings are separated out; everything else means the child
 * finished. Reporting *something* in every case is the point — a settle that
 * reported nothing would be a hang — so an empty or assistant-less run counts as
 * failed rather than silently succeeding.
 */

import type { ChildSettle } from "./report.ts";

/** Only the fields of a turn message this module reasons about. */
export interface TurnMessage {
	role?: string;
	stopReason?: string;
}

/**
 * What a settled run means.
 *
 * `interrupted` is deliberately not a `ChildSettle`: it is the one verdict that
 * is *not* reportable, because the child it describes has not finished.
 */
export type SettleVerdict = ChildSettle | "interrupted";

/**
 * Which settle reason a run ended with.
 *
 * At settle time the run is over whatever the stop reason says, so only the two
 * genuinely bad endings are separated out; everything else — `stop`, a truncated
 * `length`, a stop reason this code has never heard of — means the child
 * finished and its last message is the result. Reporting *something* in every
 * case is the point: a settle that reported nothing would be a hang.
 *
 * A run that produced no assistant message at all counts as failed, because
 * nothing was accomplished and there is no result to hand back.
 *
 * `aborted` is separated out from `error` rather than folded into it: an abort is
 * the user stopping the run to redirect it, not the run going wrong. It is only
 * half the picture — pi does not label every interrupt this way — which is why the
 * settle hook checks the run's own signal as well.
 */
export function settleReason(messages: readonly TurnMessage[] | undefined): SettleVerdict {
	const list = messages ?? [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const message = list[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "interrupted";
		return message.stopReason === "error" ? "failed" : "done";
	}
	return "failed";
}

/**
 * The reason to record for a failed settle.
 *
 * `aborted` is absent by construction — `settleReason` never calls a failed
 * settle aborted — so all that is left to distinguish is an errored turn from a
 * run that produced no assistant message to judge at all.
 */
export function failureDetail(messages: readonly TurnMessage[] | undefined): string {
	const list = messages ?? [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		if (list[i]?.role === "assistant") return "error";
	}
	return "no-output";
}
