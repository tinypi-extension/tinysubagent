/**
 * Turning finished subagents into the one message the orchestrator sees.
 *
 * Parallel children settle independently, but they are reported together: the
 * caller asked one question, so it gets one answer, with every child labelled.
 * That is a deliberate departure from the reference implementation, which sends
 * one steer message per child and lets the orchestrator infer which reply
 * belongs to which request from the surrounding conversation.
 */

import type { SubagentOutcome } from "./watcher.ts";

export interface SubagentResult {
	name: string;
	agent: string | null;
	profile: string | null;
	paneId: string;
	task: string;
	outcome: SubagentOutcome;
	elapsedMs: number;
	sessionFile: string;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function statusLabel(outcome: SubagentOutcome): string {
	switch (outcome.kind) {
		case "completed":
			// A reported result is the child's own hand-back, not a settlement the
			// watcher inferred — worth saying, because it is the strongest ending.
			if (outcome.via === "report") return "completed (reported)";
			return outcome.via === "session-exit" ? "completed (session exited)" : "completed";
		case "failed":
			// `exit` means the process died before it could report how it went;
			// anything else is the child telling us which ending it settled on.
			return outcome.reason === "exit" ? `failed (exit ${outcome.exitCode})` : `failed (${outcome.reason})`;
		case "cancelled":
			return "cancelled (pane closed without reporting)";
	}
}

/** Collapse a task to a single readable line for the result header. */
function oneLine(task: string, limit = 160): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Header line: one child is named, several are counted. */
function header(results: readonly SubagentResult[]): string {
	const first = results[0];
	if (results.length === 1 && first) return `Subagent \`${first.name}\` finished.`;
	const completed = results.filter((result) => result.outcome.kind === "completed").length;
	const failed = results.filter((result) => result.outcome.kind !== "completed").length;
	const detail = failed > 0 ? `${completed} completed, ${failed} did not` : `${completed} completed`;
	return `${results.length} subagents finished (${detail}).`;
}

function section(result: SubagentResult, index: number, total: number): string {
	const summary = result.outcome.summary?.trim() ?? "";
	// A failed child's summary is an error message, not a report — say so. Without
	// the label it reads as the subagent's own account of its work.
	const body =
		summary === ""
			? `_(no output captured — inspect pane \`${result.paneId}\`)_`
			: result.outcome.kind === "failed"
				? `**Error:** ${summary}`
				: summary;

	const meta = [
		result.agent ? `agent \`${result.agent}\`` : null,
		result.profile ? `profile \`${result.profile}\`` : null,
		`pane \`${result.paneId}\``,
	].filter((part): part is string => part !== null);

	const heading =
		total === 1
			? `## ${result.name} — ${statusLabel(result.outcome)}, ${formatDuration(result.elapsedMs)}`
			: `## ${index + 1}. ${result.name} — ${statusLabel(result.outcome)}, ${formatDuration(result.elapsedMs)}`;

	return [
		heading,
		meta.join(" · "),
		`**Task:** ${oneLine(result.task)}`,
		body,
	].join("\n\n");
}

/** The steer body: a header plus one labelled section per child. */
export function buildResultText(results: readonly SubagentResult[]): string {
	if (results.length === 0) return "No subagents finished.";
	const sections = results.map((result, index) => section(result, index, results.length));
	return [header(results), ...sections].join("\n\n---\n\n");
}

/** Structured payload for the TUI and for whatever else wants the raw outcome. */
export function buildResultDetails(results: readonly SubagentResult[]): Record<string, unknown> {
	return {
		status: "finished",
		results: results.map((result) => {
			const outcome = result.outcome;
			return {
				name: result.name,
				agent: result.agent,
				profile: result.profile,
				paneId: result.paneId,
				sessionFile: result.sessionFile,
				task: result.task,
				elapsedMs: result.elapsedMs,
				outcome: outcome.kind,
				via: outcome.kind === "completed" ? outcome.via : undefined,
				reason: outcome.kind === "failed" ? outcome.reason : undefined,
				exitCode: outcome.kind === "failed" ? outcome.exitCode : undefined,
				summary: outcome.summary,
			};
		}),
	};
}
