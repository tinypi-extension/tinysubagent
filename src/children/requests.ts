/**
 * Turning the tool's raw arguments into validated spawn requests, and resolving
 * the working directory and agent dir those requests run against.
 *
 * Pure shaping and path resolution: no pane, no pi extension API, and no
 * dependency on `spawn.ts`. `MAX_PARALLEL_TASKS` lives here because
 * `collectRequests` is its only user.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { CONFIG_FILENAME, type TinysubagentConfig } from "../config/config.ts";
import type { ChildHarness } from "./harness/types.ts";
import { hasShareableContext } from "./shared-context.ts";
import type { SharedContextSource, SpawnRequest, ToolParams } from "./contract.ts";

export const MAX_PARALLEL_TASKS = 4;

/** Append `-2`, `-3`, … so two children can never share a label or artifact name. */
export function uniqueName(base: string, used: Set<string>): string {
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/** Validate and normalize the required `tasks` array into spawn requests. */
export function collectRequests(
	input: ToolParams,
): { ok: true; requests: SpawnRequest[] } | { ok: false; error: string } {
	const tasks = input.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return { ok: false, error: "provide at least one task in `tasks`." };
	}
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return { ok: false, error: `too many tasks: ${tasks.length} (limit ${MAX_PARALLEL_TASKS}).` };
	}

	const requests: SpawnRequest[] = [];
	const used = new Set<string>();
	for (const [index, item] of tasks.entries()) {
		if (typeof item?.agent !== "string" || typeof item?.task !== "string") {
			return { ok: false, error: `tasks[${index}] needs both "agent" and "task".` };
		}
		const agent = item.agent.trim();
		const task = item.task.trim();
		if (agent === "" || task === "") {
			return { ok: false, error: `tasks[${index}] needs a non-empty "agent" and "task".` };
		}
		requests.push({
			agent,
			task,
			name: uniqueName(item.name?.trim() || agent, used),
			profile: item.profile,
			// Only when asked: a request that did not ask for a share must stay the
			// object it always was, so nothing downstream can treat it differently.
			...(item.shareContext === true ? { shareContext: true } : {}),
		});
	}
	return { ok: true, requests };
}

// ────────────────────────────────────────────────────────────────────────────
// Session-derived values
// ────────────────────────────────────────────────────────────────────────────

/**
 * Refuse a share the config never permitted, naming the key and the file that
 * would set it. The schema leaves `shareContext` out of the task object while the
 * gate is off, but a benign extra key must never fail a whole batch at pi's
 * validation layer — so an impossible share is refused here, on its own request,
 * before any pane opens, rather than by the schema.
 */
export function refuseUnpermittedShare(config: TinysubagentConfig, request: SpawnRequest): string | null {
	if (config.canShareContext === true) return null;
	if (request.shareContext !== true) return null;
	// The highest-precedence file owns the switch, so it is the one to name — as a
	// basename, because this string ends up in a tool error, not a log.
	const source = config.sources[0];
	const named = source ? basename(source.file) : CONFIG_FILENAME;
	return (
		`shareContext cannot be used: sharing this conversation is disabled ` +
		`("canShareContext" is not true in ${named}).`
	);
}

/**
 * Refuse a share the child cannot be given, naming the cause a human can act on:
 * a harness that keeps no session file has nothing to fork into, an orchestrator
 * started without a session has nothing to fork from, and a branch with no user
 * entry has nothing to fork at all. Either way the brief was written as if the
 * child knows this conversation, so launching a clean one would be a different
 * spawn than the one asked for.
 *
 * Refused per request, not per batch: the siblings are still exactly what the
 * caller asked for. Read through `harness.writesSession` and the presence of the
 * context itself, so no harness name is hardcoded here.
 */
export function refuseUnhonourableShare(input: {
	request: SpawnRequest;
	/** The harness this request's profile resolves to. */
	harness: Pick<ChildHarness, "id" | "writesSession">;
	/** The orchestrator's conversation, or null when there is no file to fork. */
	sharedContext: SharedContextSource | null | undefined;
}): string | null {
	const { request, harness, sharedContext } = input;
	if (request.shareContext !== true) return null;
	const wouldStartEmpty =
		"the subagent would start with an empty context instead of this conversation";
	if (!harness.writesSession) {
		return (
			`shareContext cannot be honoured for "${request.name}": the ${harness.id} harness keeps no ` +
			`session file to fork, so ${wouldStartEmpty}. ` +
			"Omit shareContext for this request, or run it on a pi profile."
		);
	}
	if (!sharedContext) {
		return (
			`shareContext cannot be honoured for "${request.name}": this session has no session file ` +
			`to fork (pi was started without one), so ${wouldStartEmpty}. ` +
			"Omit shareContext for this request, or restart pi with a session."
		);
	}
	if (!hasShareableContext(sharedContext)) {
		return (
			`shareContext cannot be honoured for "${request.name}": this conversation has no user ` +
			`message to fork yet, so ${wouldStartEmpty}. ` +
			"Omit shareContext for this request, or ask again once the conversation has one."
		);
	}
	return null;
}

/** A project-local `.pi/agent` shadows the user's agent dir for the child. */
export function resolveProjectAgentDir(cwd: string): string | null {
	const local = join(cwd, ".pi", "agent");
	return existsSync(local) ? local : null;
}

export function resolveCwd(candidate: string | undefined, fallback: string): string {
	const raw = candidate?.trim();
	if (!raw) return fallback;
	return isAbsolute(raw) ? raw : resolvePath(fallback, raw);
}
