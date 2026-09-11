/**
 * Completion delivery: wait for a whole batch, then report once.
 *
 * Children settle independently and a watcher always ends — on a report, on an
 * exit code, or on the pane disappearing — so a batch cannot hang on one dead
 * child. Watcher ownership stays with the caller (index.ts); this module only
 * adds and removes the controllers it creates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrPaneClose } from "../herdr/cli.ts";
import type { LiveSubPanes } from "../herdr/layout.ts";
import { waitForSubagent, type RunningSubagent } from "../children/watcher.ts";
import { buildResultDetails, buildResultText, type SubagentResult } from "../present/steer.ts";

export interface WatchBatchDeps {
	pi: ExtensionAPI;
	/** Watchers still running, so a shutdown can end them; owned by the caller. */
	watchers: Set<AbortController>;
	/** Reads the caller's shutdown flag, so nothing is delivered after it. */
	isShuttingDown: () => boolean;
	/** The sub panes this registration opened; a completed child is dropped here. */
	columns: LiveSubPanes;
}

/** Send one steer message for a settled batch. Silent when shutting down or empty. */
export function deliver(pi: ExtensionAPI, results: SubagentResult[], isShuttingDown: () => boolean): void {
	if (isShuttingDown() || results.length === 0) return;
	pi.sendMessage(
		{
			customType: "tinysubagent_result",
			content: buildResultText(results),
			display: true,
			details: buildResultDetails(results),
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

/**
 * Wait for a batch, then report once. Each child gets its own controller, added
 * to the caller's watcher set and removed again as soon as it settles.
 */
export async function watchBatch(runnings: readonly RunningSubagent[], deps: WatchBatchDeps): Promise<void> {
	const { watchers, columns } = deps;
	const controllers = runnings.map(() => {
		const controller = new AbortController();
		watchers.add(controller);
		return controller;
	});

	const settled = await Promise.all(
		runnings.map(async (running, index) => {
			const controller = controllers[index];
			const outcome = await waitForSubagent(running, controller?.signal);
			if (controller) watchers.delete(controller);

			// The child's pi is gone by the time a completion lands, so this only
			// reaps a pane that outlived it. A failure is left on screen instead,
			// so the reason stays readable. No rebalance runs here: the layout is
			// set at spawn time and a close never revisits it.
			if (outcome.kind === "completed") {
				columns.drop(running.paneId);
				void herdrPaneClose(running.paneId);
			}

			return {
				name: running.name,
				agent: running.agent,
				profile: running.profile,
				paneId: running.paneId,
				task: running.task,
				outcome,
				elapsedMs: Date.now() - running.startedAt,
				sessionFile: running.sessionFile,
			} satisfies SubagentResult;
		}),
	);

	deliver(deps.pi, settled, deps.isShuttingDown);
}
