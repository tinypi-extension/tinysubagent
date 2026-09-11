/**
 * Turning the tool's raw arguments into validated spawn requests, and resolving
 * the working directory and agent dir those requests run against.
 *
 * Pure shaping and path resolution: no pane, no pi extension API, and no
 * dependency on `spawn.ts`. `MAX_PARALLEL_TASKS` lives here because
 * `collectRequests` is its only user.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { SpawnRequest, ToolParams } from "./contract.ts";

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

/**
 * Validate the argument shape. Exactly one mode is allowed: `agent` + `task`, or
 * `tasks`. Mixing them is a caller error rather than something to silently
 * prefer one way or the other.
 */
export function collectRequests(
	input: ToolParams,
): { ok: true; requests: SpawnRequest[] } | { ok: false; error: string } {
	const tasks = input.tasks;
	const hasSingle = input.agent !== undefined || input.task !== undefined;

	if (Array.isArray(tasks) && tasks.length > 0) {
		if (hasSingle) {
			return { ok: false, error: "pass either `agent` + `task`, or `tasks` — not both." };
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
			});
		}
		return { ok: true, requests };
	}

	if (typeof input.agent !== "string" || typeof input.task !== "string") {
		return { ok: false, error: "provide `agent` and `task` for one subagent, or `tasks` for several." };
	}
	const agent = input.agent.trim();
	const task = input.task.trim();
	if (agent === "" || task === "") {
		return { ok: false, error: "`agent` and `task` must both be non-empty." };
	}
	const used = new Set<string>();
	return {
		ok: true,
		requests: [{ agent, task, name: uniqueName(input.name?.trim() || agent, used), profile: input.profile }],
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Session-derived values
// ────────────────────────────────────────────────────────────────────────────

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
