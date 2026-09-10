/**
 * Reading a subagent's result back out of its session file.
 *
 * A subagent's session is a version-3 `.jsonl` log that pi appends to as the run
 * progresses, so the answer to "what did it say?" is already on disk by the time
 * the completion sidecar lands. Nothing needs to be copied between processes:
 * the sidecar says *when*, this module says *what*.
 *
 * Parsing is intentionally forgiving. The last line of an incrementally written
 * log can be a partial write, so an unparseable line is skipped rather than
 * failing the whole read — losing the final line would lose the answer.
 */

import { readFileSync } from "node:fs";

interface SessionEntry {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		/** Set by pi when a request ends in `error`, e.g. an auth or model failure. */
		errorMessage?: string;
	};
}

/** Non-empty `text` blocks of a message content array. */
function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string" && record.text.trim() !== "") {
			texts.push(record.text);
		}
	}
	return texts;
}

export function parseSessionEntries(raw: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") entries.push(parsed as SessionEntry);
		} catch {
			// Partial trailing write; skip it.
		}
	}
	return entries;
}

export function readSessionEntries(file: string): SessionEntry[] {
	try {
		return parseSessionEntries(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

/**
 * The last assistant message that actually contains text. Messages consisting
 * only of tool calls are skipped, so a run that ends on a tool call still
 * reports the sentence it wrote before it.
 */
export function findFinalMessage(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const texts = textBlocks(entry.message.content);
		if (texts.length > 0) return texts.join("\n");
	}
	return null;
}

export function readFinalMessage(file: string): string | null {
	return findFinalMessage(readSessionEntries(file));
}

/** Longer than any error worth reading; a verbose one is clipped, not dropped. */
const MAX_FAILURE_NOTE = 1_000;

/**
 * Why a failed run failed.
 *
 * An errored turn usually carries no text at all — pi renders the reason instead
 * — so without this a failure would arrive as "no output captured" and the
 * orchestrator would have to go and read the pane to learn anything. The
 * message is already on disk, so it is worth handing back with the failure.
 */
export function findFailureNote(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const note = entry.message.errorMessage?.trim();
		if (!note) return null;
		return note.length <= MAX_FAILURE_NOTE ? note : `${note.slice(0, MAX_FAILURE_NOTE - 1)}…`;
	}
	return null;
}

export function readFailureNote(file: string): string | null {
	return findFailureNote(readSessionEntries(file));
}
