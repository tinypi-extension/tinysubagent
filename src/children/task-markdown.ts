/**
 * Task markdown: role identity, then the instruction, then the task, then the
 * output contract. Injecting the role body here (rather than as a system prompt)
 * is what the reference does for roles that do not opt into system-prompt
 * replacement — and none of the installed roles do.
 *
 * The output contract names the report tool explicitly. It is the last thing the
 * child reads, and a model that never learns the tool name never calls it — and
 * an unreported turn end keeps the pane open and the batch waiting (the settle
 * asks the child again, but never reports on its behalf), so naming the tool here
 * is the difference between a finished batch and a held one.
 */

import { REPORT_TOOL_NAME } from "../types.ts";

export function buildTaskMarkdown(opts: {
	body?: string | null;
	task: string;
}): string {
	const roleBlock = opts.body && opts.body.trim() !== "" ? `${opts.body.trim()}\n\n` : "";
	return (
		`${roleBlock}Complete your task autonomously.\n\n` +
		`${opts.task.trim()}\n\n` +
		`When your task is complete, call \`${REPORT_TOOL_NAME}\` with your full result in the ` +
		"`result` argument. That call is what the caller receives and what closes this pane — " +
		"do not skip it. A final assistant message is for the human watching the pane, not for " +
		"the caller; only the call delivers. Ending your turn without the call sends nothing: " +
		"this pane stays open and the caller keeps waiting until you report."
	);
}
