/**
 * Batch completion: wait for every child, then hand the results back.
 *
 * Children settle independently and a watcher ends only on a report, an exit
 * code, or the pane disappearing. A non-report ending leaves a live child at
 * its prompt instead, so the batch waits on that pane until a human resolves
 * it. The tool call blocks on this wait, so the results are the call's return
 * value; nothing is sent to the orchestrator afterwards. Watcher ownership
 * stays with the caller (index.ts); this module only adds and removes the
 * controllers it creates.
 *
 * A pane is closed only when the child is gone anyway — it reported, or its
 * session exited. A completion that came from a settle leaves the child alive at
 * its prompt and its pane open, as does every failure and cancellation.
 */

import { herdrPaneClose } from "../herdr/cli.ts";
import type { LiveSubPanes } from "../herdr/layout.ts";
import { waitForSubagent, type RunningSubagent } from "../children/watcher.ts";
import type { SubagentResult } from "../present/result.ts";

export interface WatchBatchDeps {
	/** Watchers still running, so a shutdown can end them; owned by the caller. */
	watchers: Set<AbortController>;
	/** The sub panes this registration opened; a child whose pane was closed is dropped here. */
	columns: LiveSubPanes;
	/**
	 * Called once per child as its wait settles, whatever the outcome, so the
	 * Label it held can be claimed again. Optional: a caller with nothing to
	 * release simply omits it.
	 */
	releaseLabel?: (label: string) => void;
}

/**
 * Wait for a batch and return one result per child, in the order they were
 * spawned. Each child gets its own controller, added to the caller's watcher
 * set and removed again as soon as it settles.
 *
 * `signal` is the tool call's own: when the human interrupts the turn, every
 * in-flight wait resolves as cancelled so the call can return. A cancelled
 * child is never closed — its pane is left exactly where the human can still
 * use it.
 */
export async function watchBatch(
	runnings: readonly RunningSubagent[],
	signal: AbortSignal | undefined,
	deps: WatchBatchDeps,
): Promise<SubagentResult[]> {
	const { watchers, columns } = deps;
	const controllers = runnings.map(() => {
		const controller = new AbortController();
		watchers.add(controller);
		return controller;
	});

	// The call's signal is not a pane's fate: forwarding it only ends the waits,
	// never the children. Each child's controller is what the watcher listens to.
	const forward = (): void => {
		for (const controller of controllers) controller.abort();
	};
	signal?.addEventListener("abort", forward, { once: true });
	if (signal?.aborted) forward();

	try {
		return await Promise.all(
			runnings.map(async (running, index) => {
				const controller = controllers[index];
				const outcome = await waitForSubagent(running, controller?.signal);
				if (controller) watchers.delete(controller);
				// The wait is over however it ended — reported, failed, cancelled, or
				// aborted — so the Label this child held is free again.
				deps.releaseLabel?.(running.name);

				// Only a wait that ended *because* the child is over may close its pane.
				// A report and a session exit are both the child leaving: nothing is left
				// to read there. A turn-end completion is different — the child is alive at
				// its prompt with no summary to hand back, so the pane is the only evidence
				// of what it did and is deliberately left open. A failure or a
				// cancellation is left on screen too: there is a reason to read, or a
				// human to keep driving it. No rebalance runs here: the layout is set at
				// spawn time and a close never revisits it.
				if (outcome.kind === "completed" && outcome.via !== "turn-end") {
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
	} finally {
		signal?.removeEventListener("abort", forward);
		for (const controller of controllers) watchers.delete(controller);
	}
}
