/**
 * Settle classification: did this turn finish cleanly?
 *
 * The child no longer declares an outcome at settle time; the explicit
 * `subagent_report` is the only thing that does. All a settle still needs is
 * the one answer to "can this turn be reminded to report?" — a turn that
 * finished cleanly without one. An error, an interrupt, and a turn that
 * produced no assistant message at all are all silence: the child stays at its
 * prompt, and the watcher keeps waiting on the pane.
 */

/** Only the fields of a turn message this module reasons about. */
export interface TurnMessage {
	role?: string;
	stopReason?: string;
}

/**
 * True when the run's last assistant message finished without an error or an
 * interrupt.
 *
 * `aborted` is an interrupt, not a completion: the user stopped the turn to
 * redirect it, and the child is alive at its prompt. An `error` may be a real
 * provider failure or an Esc that landed on a tool call — pi labels both the
 * same — and neither is an ending. A run that produced no assistant message
 * has nothing to remind and nothing to report either.
 *
 * Any other stop reason — `stop`, a truncated `length`, one this code has never
 * heard of — is a turn the child completed.
 */
export function finishedCleanly(messages: readonly TurnMessage[] | undefined): boolean {
	const message = lastAssistantMessage(messages);
	if (!message) return false;
	return message.stopReason !== "error" && message.stopReason !== "aborted";
}

/** The last assistant message, or undefined when there is none. */
function lastAssistantMessage(
	messages: readonly TurnMessage[] | undefined,
): TurnMessage | undefined {
	const list = messages ?? [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		if (list[i]?.role === "assistant") return list[i];
	}
	return undefined;
}
