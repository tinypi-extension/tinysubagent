/**
 * Task markdown: role identity, then the instruction, then the task, then the
 * output contract. Injecting the role body here (rather than as a system prompt)
 * is what the reference does for roles that do not opt into system-prompt
 * replacement — and none of the installed roles do.
 *
 * The output contract names the report tool explicitly. It is the last thing the
 * child reads, and a model that never learns the tool name never calls it — its
 * result is then only ever a scrape of the session. The fallback is still stated
 * so a child that skips the call is not left without a way to finish.
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
		"do not skip it. Write your final assistant message as that same self-contained summary; " +
		"if the report does not arrive, the caller reads it instead."
	);
}
