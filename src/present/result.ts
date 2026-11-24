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
import type { ShareCost } from "../children/contract.ts";
import type { SubagentOutcome } from "../children/watcher.ts";
import { formatShareCost } from "./ack.ts";

export interface SubagentResult {
	name: string;
	agent: string | null;
	profile: ResolvedProfile | null;
	/**
	 * The pane this child owns, when it is supervised as one. A child supervised as
	 * a process has no pane and no label standing in for it, so the report simply
	 * says nothing about a pane for it.
	 */
	paneId?: string;
	task: string;
	outcome: SubagentOutcome;
	elapsedMs: number;
	sessionFile: string;
	/** What the fork cost, for a child spawned with the orchestrator's context. */
	sharedContext?: ShareCost;
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
			// The human stopped the turn and nothing reported. Which interrupt it was
			// decides the pane's fate: the operator's own closes the pane it stopped,
			// while a shutdown under the wait leaves it open.
			return outcome.cause === "shutdown" ? "interrupted (pane left open)" : "interrupted (pane closed)";
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
 * The batch-level statement an interrupted result leads with.
 *
 * The operator stopped the batch, not one child, and that is a fact about the
 * whole result rather than any section. It reports the panes as they really are:
 * an operator's interrupt closes every pane it relayed to, while a batch ended by
 * a shutdown had nothing relayed and left every pane open. A completed child's
 * pane is gone either way and is not claimed here. The cause is read from the
 * interrupted rows, since the whole batch shares it. `null` when no child was
 * interrupted, because an uninterrupted batch needs no note.
 */
function interruptNote(results: readonly SubagentResult[]): string | null {
	const interrupted = results.filter((result) => result.outcome.kind === "interrupted");
	if (interrupted.length === 0) return null;
	const leftOpen = interrupted.some(
		(result) => result.outcome.kind === "interrupted" && result.outcome.cause === "shutdown",
	);
	const fate = leftOpen ? "left open" : "closed";
	if (interrupted.length === results.length) {
		return `The batch was interrupted: every child's pane was ${fate}.`;
	}
	if (interrupted.length === 1) {
		return `The batch was interrupted: the interrupted child's pane was ${fate}.`;
	}
	return `The batch was interrupted: the interrupted children's panes were ${fate}.`;
}

/**
 * What a never-started child's report says where there is no pane to open.
 *
 * Under a pane host the remedy *is* the pane: it is left open at the child's
 * prompt, so logging in there fixes the next attempt. A plain child has no pane,
 * so the report carries the instruction instead — and it names the causes that
 * actually produce this: no credential, a `pi` that will not run, and whatever
 * the child printed before it gave up.
 */
const NEVER_STARTED_REMEDY =
	"_(no output captured: pi never started, so no run happened. Log in to the provider its profile " +
	"names — or fix the `pi` it launches — and delegate again; anything it printed before giving up " +
	"is the diagnostic, quoted below when it wrote one.)_";

/**
 * What to print in place of a summary a child did not leave.
 *
 * A failed child's pane is worth pointing at — the error is on screen there. A
 * completion without a summary never reported at all, and how the wait ended
 * decides where to look: a turn-end leaves the child alive at its prompt with its
 * pane open, while a session exit is gone and there is nothing to inspect. An
 * interrupt is the human's own doing, and its cause says what became of the pane:
 * the operator's interrupt closed it, a shutdown left it open.
 *
 * A child with no pane has nothing to point at, so the failure says what happened
 * instead of sending the reader to an address that does not exist — and a
 * never-started run, whose whole remedy used to be the pane it was left at, is
 * told what to do instead (see {@link NEVER_STARTED_REMEDY}).
 */
export function emptySummaryText(
	outcome: {
		kind: SubagentOutcome["kind"];
		via?: string;
		cause?: "interrupt" | "shutdown";
		/** The failure's kind, for the one remedy that is not about a pane. */
		reason?: string;
	},
	paneId?: string,
): string {
	if (outcome.kind === "completed") {
		return outcome.via === "turn-end"
			? "_(no summary: the child never reported — its turn ended without one, and its pane is still open)_"
			: "_(no summary: the child never reported before its session exited)_";
	}
	if (outcome.kind === "interrupted") {
		return outcome.cause === "shutdown"
			? "_(no summary: the child was interrupted and its pane was left open)_"
			: "_(no summary: the child was interrupted and its pane was closed)_";
	}
	if (outcome.reason === "never-started" && paneId === undefined) return NEVER_STARTED_REMEDY;
	return paneId === undefined
		? "_(no output captured: the child ended without reporting)_"
		: `_(no output captured — inspect pane \`${paneId}\`)_`;
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
		result.paneId === undefined ? null : `pane \`${result.paneId}\``,
		formatShareCost(result.sharedContext),
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
		result.outcome.kind === "failed" ? stderrBlock(result.outcome.stderr) : null,
	]
		.filter((part): part is string => part !== null)
		.join("\n\n");
}

/**
 * A failed child's stderr, drawn as the last thing in its section.
 *
 * Indented rather than fenced: it is a program's own output and may hold any
 * character, while four leading spaces cannot be closed by the first line of it.
 * Bounded where it was kept, not here — the tail is already the end of it.
 *
 * `null` when there is nothing to quote, so a failure with no stderr stream reads
 * exactly as it did before the tail existed.
 */
function stderrBlock(stderr: string | undefined): string | null {
	if (stderr === undefined || stderr.trim() === "") return null;
	const lines = stderr.split("\n").map((line) => `    ${line}`);
	return ["**Failure output (stderr tail):**", "", ...lines].join("\n");
}

/** The report body: a header plus one labelled section per child. */
export function buildResultText(results: readonly SubagentResult[]): string {
	if (results.length === 0) return "No subagents finished.";
	const sections = results.map((result, index) => section(result, index, results.length));
	const note = interruptNote(results);
	const lead = note === null ? header(results) : `${header(results)}\n\n${note}`;
	return [lead, ...sections].join("\n\n---\n\n");
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
	/** Absent for a child supervised as a process: it has no pane to name. */
	paneId?: string;
	sessionFile: string;
	task: string;
	elapsedMs: number;
	elapsed: string;
	status: string;
	outcome: SubagentOutcome["kind"];
	via?: string;
	/** Which interrupt ended the wait, for an `interrupted` row. */
	cause?: "interrupt" | "shutdown";
	reason?: string;
	exitCode?: number | null;
	/**
	 * The tail of a failed child's stderr, when it had a stream of its own to write
	 * one to. Absent for every other ending, and for a failure with nothing there.
	 */
	stderr?: string;
	summary: string | null;
	/** The share's two figures, or null for a child launched without one. */
	sharedContext: ShareCost | null;
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
				cause: outcome.kind === "interrupted" ? outcome.cause : undefined,
				reason: outcome.kind === "failed" ? outcome.reason : undefined,
				exitCode: outcome.kind === "failed" ? outcome.exitCode : undefined,
				stderr: outcome.kind === "failed" ? outcome.stderr : undefined,
				summary: outcome.kind === "interrupted" ? null : outcome.summary,
				sharedContext: result.sharedContext ?? null,
			} satisfies ResultDetail;
		}),
	};
}
