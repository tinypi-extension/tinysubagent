/**
 * The shared context: a fork of the orchestrator's own branch, rendered as the
 * child's session JSONL and written to the session path the launch recipe
 * already planned.
 *
 * pi's `--fork` cannot be used: it picks its own session path, and the watcher
 * reads the one we plan (`launch-paths.ts`). So the file is rebuilt here — which
 * also makes it a *conversation* fork rather than a session record: the child
 * builds its own prompt, and the branch is cut after its last user entry so the
 * assistant message that called `subagent` (an unresolved tool call) is never
 * inherited.
 *
 * Pure: nothing here touches the filesystem, a pane, or module state. The caller
 * writes the JSONL where the child will open it.
 */

import { basename } from "node:path";
import type { SessionEntry, SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { ShareCost, SharedContextSource } from "./contract.ts";

/** The slice of the (read-only) session manager a share needs. */
export type SharedContextReader = Pick<SessionManager, "getSessionFile" | "buildContextEntries" | "getHeader">;

/**
 * The orchestrator's own conversation, or null when there is no session file to
 * fork — `--no-session` has nothing to hand over. `buildContextEntries()` is the
 * source of truth for the branch: an already-compacted session is shared
 * compacted, and abandoned branches are never copied.
 */
export function readSharedContext(sessionManager: SharedContextReader): SharedContextSource | null {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) return null;
	return {
		sessionFile,
		branch: sessionManager.buildContextEntries(),
		version: sessionManager.getHeader()?.version ?? CURRENT_SESSION_VERSION,
	};
}

export interface SharedContextFork {
	/** The fork, header line first — exactly what goes into the child's file. */
	jsonl: string;
	/** What this share costs, for the acknowledgment row and the result meta. */
	cost: ShareCost;
	/**
	 * Lines written to the child's session file: the header plus the body. The
	 * watcher's launch baseline is the file as a whole, not the share's body count,
	 * so the fork reports it rather than making the caller add the header back on.
	 */
	lines: number;
}

export interface BuildSharedContextForkInput {
	source: SharedContextSource;
	/** The planned child session file; its uuid becomes the fork's header id. */
	childSessionFile: string;
	/** The request's cwd, stamped into the header the child will read. */
	cwd: string;
	now?: Date;
}

/**
 * Whether a fork of this conversation would carry anything at all: a branch that
 * reaches a user entry exists, one that does not is only the orchestrator's prompt
 * and has nothing a child could be handed.
 */
export function hasShareableContext(source: SharedContextSource): boolean {
	return shareableEntries(source.branch).length > 0;
}

/**
 * Render the fork, or null when there is nothing worth forking (a branch with no
 * user entry yet). A caller that asked for a share must refuse it by name rather
 * than launch the clean child this would otherwise become.
 */
export function buildSharedContextFork(input: BuildSharedContextForkInput): SharedContextFork | null {
	const copied = shareableEntries(input.source.branch);
	if (copied.length === 0) return null;

	const header: SessionHeader = {
		type: "session",
		version: input.source.version,
		// Must agree with the uuid in the filename, the way pi names its own files.
		id: sessionIdFromFile(input.childSessionFile),
		timestamp: (input.now ?? new Date()).toISOString(),
		cwd: input.cwd,
		parentSession: input.source.sessionFile,
	};

	// Re-chained linearly under the new header, the shape pi writes for its own
	// forks: one root, one link per entry, ids and timestamps untouched.
	let parentId: string | null = null;
	const body = copied.map((entry) => {
		const rendered = { ...withoutSystemPrompt(entry), parentId };
		parentId = entry.id;
		return rendered;
	});

	const jsonl = [header, ...body].map((entry) => `${JSON.stringify(entry)}\n`).join("");
	return {
		jsonl,
		cost: { entries: body.length, tokens: approximateTokens(body) },
		lines: body.length + 1,
	};
}

/**
 * What a child may inherit: everything but the orchestrator's prompt, stopping at
 * the last user entry. The tail after it is the delegation itself — an assistant
 * tool call with no result, plus whatever else that turn produced.
 *
 * `system` is read structurally: pi writes those entries into the session file,
 * but the pinned pi types do not yet list the role.
 */
function shareableEntries(branch: readonly SessionEntry[]): SessionEntry[] {
	let cut = -1;
	for (const [index, entry] of branch.entries()) {
		if (roleOf(entry) === "user") cut = index;
	}
	if (cut < 0) return [];
	return branch.slice(0, cut + 1).filter((entry) => roleOf(entry) !== "system");
}

/** A message entry's role, or undefined for any other entry kind. */
function roleOf(entry: SessionEntry): string | undefined {
	return entry.type === "message" ? (entry.message as { role?: string }).role : undefined;
}

/**
 * The orchestrator's prompt, stripped from an entry that carries it.
 *
 * pi records its system message — every prompt section and the tool declarations —
 * on the compaction entry as `systemMessage`, and replays that field as a context
 * message when the session is loaded. Inheriting it would advertise `subagent` to a
 * child that cannot spawn and overwrite the allowlist its role declared, which is
 * exactly what the fork exists to prevent. Removed by key from every entry rather
 * than from `compaction` alone: the entry types that exist today are not a promise
 * about where pi writes the prompt next, and the pinned types do not list the
 * field at all. The summary on the same entry stays — an already-compacted branch
 * is still shared compacted.
 */
function withoutSystemPrompt(entry: SessionEntry): SessionEntry {
	if (!("systemMessage" in entry)) return entry;
	const kept: Record<string, unknown> = { ...entry };
	delete kept.systemMessage;
	return kept as unknown as SessionEntry;
}

/** `<timestamp>_<session-id>.jsonl` → `<session-id>`. */
function sessionIdFromFile(file: string): string {
	const name = basename(file).replace(/\.jsonl$/, "");
	const separator = name.indexOf("_");
	return separator < 0 ? name : name.slice(separator + 1);
}

/** The acknowledgment's order of magnitude, not an accounting figure. */
function approximateTokens(entries: readonly SessionEntry[]): number {
	return Math.ceil(JSON.stringify(entries).length / 4);
}
