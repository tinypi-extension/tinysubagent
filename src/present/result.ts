/**
 * Turning a finished batch into the one tool result the orchestrator sees.
 *
 * Parallel children settle independently, but they are reported together: the
 * caller asked one question, so it gets one answer, with every child labelled.
 * The tool call blocks until the batch is over, so this text is the return
 * value rather than a later message.
 */

import { resolvedProfileLabel } from "../config/profiles.ts";
import type { ResolvedProfile } from "../config/profiles.ts";
import type { SubagentOutcome } from "../children/watcher.ts";

export interface SubagentResult {
	name: string;
	agent: string | null;
	profile: ResolvedProfile | null;
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
			// anything else — an error, a missing output, a run that never started —
			// is the reader's own reading of how it ended.
			return outcome.reason === "exit" ? `failed (exit ${outcome.exitCode})` : `failed (${outcome.reason})`;
		case "cancelled":
			return "cancelled (pane closed without reporting)";
		case "interrupted":
			// The human stopped the turn. Nothing was closed and nothing reported, so
			// the label says what is true: the pane is still there to keep driving.
			return "interrupted (pane left open)";
	}
}

/** Collapse a task to a single readable line for the result header. */
export function oneLine(task: string, limit = 160): string {
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

/**
 * What to print in place of a summary a child did not leave.
 *
 * A failed child's pane is worth pointing at — the error is on screen there. A
 * completion without a summary never reported at all, and how the wait ended
 * decides where to look: a turn-end leaves the child alive at its prompt with its
 * pane open, while a session exit is gone and there is nothing to inspect. An
 * interrupt is the human's own doing, and what it left behind is a live child at
 * its prompt: no summary is owed, and the pane is where to pick the work up.
 */
export function emptySummaryText(
	outcome: { kind: SubagentOutcome["kind"]; via?: string },
	paneId: string,
): string {
	if (outcome.kind === "completed") {
		return outcome.via === "turn-end"
			? "_(no summary: the child never reported — its turn ended without one, and its pane is still open)_"
			: "_(no summary: the child never reported before its session exited)_";
	}
	if (outcome.kind === "interrupted") {
		return "_(no summary: the child was interrupted, and its pane was left open)_";
	}
	return `_(no output captured — inspect pane \`${paneId}\`)_`;
}

function section(result: SubagentResult, index: number, total: number): string {
	// `interrupted` has no summary field at all, so the narrowing here is the
	// type's, not a check against a value that could go stale.
	const summary = result.outcome.kind === "interrupted" ? "" : (result.outcome.summary?.trim() ?? "");
	// A failed child's summary is an error message, not a report — say so. Without
	// the label it reads as the subagent's own account of its work.
	const body =
		summary === ""
			? emptySummaryText(result.outcome, result.paneId)
			: result.outcome.kind === "failed"
				? `**Error:** ${summary}`
				: summary;

	const meta = [
		result.agent ? `agent \`${result.agent}\`` : null,
		result.profile ? `profile \`${resolvedProfileLabel(result.profile)}\`` : null,
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

/** The report body: a header plus one labelled section per child. */
export function buildResultText(results: readonly SubagentResult[]): string {
	if (results.length === 0) return "No subagents finished.";
	const sections = results.map((result, index) => section(result, index, results.length));
	return [header(results), ...sections].join("\n\n---\n\n");
}

/**
 * One child in the machine-readable result: what the TUI renders and what a
 * consumer wanting the raw outcome reads. `status`, `elapsed` and `outcome` are
 * precomputed, so a renderer needs no second pass over the outcome.
 */
export interface ResultDetail {
	name: string;
	agent: string | null;
	profile: string | null;
	paneId: string;
	sessionFile: string;
	task: string;
	elapsedMs: number;
	elapsed: string;
	status: string;
	outcome: SubagentOutcome["kind"];
	via?: string;
	reason?: string;
	exitCode?: number | null;
	summary: string | null;
}

export interface ResultDetails {
	status: "finished";
	results: ResultDetail[];
}

/** The structured form of the very batch the text describes. */
export function buildResultDetails(results: readonly SubagentResult[]): ResultDetails {
	return {
		status: "finished",
		results: results.map((result) => {
			const outcome = result.outcome;
			return {
				name: result.name,
				agent: result.agent,
				profile: result.profile === null ? null : resolvedProfileLabel(result.profile),
				paneId: result.paneId,
				sessionFile: result.sessionFile,
				task: result.task,
				elapsedMs: result.elapsedMs,
				elapsed: formatDuration(result.elapsedMs),
				status: statusLabel(outcome),
				outcome: outcome.kind,
				via: outcome.kind === "completed" ? outcome.via : undefined,
				reason: outcome.kind === "failed" ? outcome.reason : undefined,
				exitCode: outcome.kind === "failed" ? outcome.exitCode : undefined,
				summary: outcome.kind === "interrupted" ? null : outcome.summary,
			} satisfies ResultDetail;
		}),
	};
}
