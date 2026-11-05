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
		});
	}
	return { ok: true, requests };
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
