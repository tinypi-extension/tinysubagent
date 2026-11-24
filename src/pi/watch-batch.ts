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
 * session exited — or when the human interrupted the batch: the relay that
 * stops the children closes the panes it typed into. A completion that came from
 * a settle leaves the child alive at its prompt and its pane open, as does every
 * failure and cancellation. A shutdown leaves every pane open too: nothing was
 * relayed, and the waits simply end.
 *
 * An interrupt of the call's turn is relayed from here. The wait is the trigger:
 * when it starts, or when the signal aborts under it, one Esc goes into every
 * live sub pane — the batch's own children and any earlier call's still open,
 * idle ones included — every wait ends as `interrupted`, and then each of those
 * panes is closed. The Esc is what stops the turn; the close is what stops the
 * child from being left behind with nobody waiting on it.
 */

import { paneChild, type LiveSubPanes } from "../pane-host/index.ts";
import { relayInterrupt } from "../children/interrupt.ts";
import { childHandle, waitForSubagent, type RunningSubagent } from "../children/watcher.ts";
import type { SubagentResult } from "../present/result.ts";
import { createLiveLines, type LiveChild, type LiveLineTuning } from "./live-lines.ts";

export interface WatchBatchDeps {
	/** Watchers still running, so a shutdown can end them; owned by the caller. */
	watchers: Set<AbortController>;
	/** The sub panes this registration opened; a child whose pane was closed is dropped here. */
	columns: LiveSubPanes;
	/**
	 * The tool call's partial channel, in the shape a live view draws: the whole
	 * batch as one line per child, then an empty view when the result arrives.
	 * Absent when the caller has no partial state to draw into.
	 */
	onLines?: (lines: readonly string[]) => void;
	/** The live view's cadence, ticker and clock; production's defaults when absent. */
	live?: LiveLineTuning;
}

/** One child as the live view needs it. */
function liveChild(running: RunningSubagent): LiveChild {
	return {
		agent: running.agent ?? running.name,
		name: running.name,
		profile: running.profile,
		sharedContext: running.sharedContext,
		startedAt: running.startedAt,
	};
}

/**
 * Wait for a batch and return one result per child, in the order they were
 * spawned. Each child gets its own controller, added to the caller's watcher
 * set and removed again as soon as it settles.
 *
 * `signal` is the tool call's own: when the human interrupts the turn, this wait
 * relays one Esc into every live sub pane, ends every in-flight wait as
 * `interrupted` and closes those panes, so the call can return with nothing left
 * running behind it.
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
	const children = runnings.map(childHandle);

	// The live view exists only where the children stream their output. A pane
	// child has no `output` member — it is addressed by its pane, and the pane is
	// the view — so a pane-host batch draws no lines even when a channel was
	// offered. This is the seam's own distinction, not a second kind check.
	const live =
		deps.onLines !== undefined &&
		children.every((child) => child !== null && typeof child.supervisor.output === "function")
			? createLiveLines(runnings.map(liveChild), { onLines: deps.onLines, ...deps.live })
			: null;

	// Subscribe before the first wait: a child starts writing as soon as it is
	// spawned, and a stream nobody reads is a pipe that fills. Each reader only
	// updates its own tail; the ticker is the sole redraw. A child's subscription
	// ends with its own wait, so a settled child adds no text to the view while
	// its siblings still run.
	const stops = children.map((child, index) => {
		if (child === null) return () => {};
		return child.supervisor.output?.(child, live?.reader(index) ?? (() => {})) ?? (() => {});
	});

	// The call's signal is not a pane's fate on its own: forwarding it relays the
	// interrupt, ends every wait, and then closes the panes it interrupted. Each
	// child's controller is what the watcher listens to. The relay is the Esc the
	// human's interrupt stands for — into every tracked pane, this batch's and any
	// earlier call's.
	//
	// The order matters: Esc, then abort, then close. Waiting for the relay before
	// aborting means a Rex send-key still in flight cannot lose its keystroke to a
	// close, and every wait still ends before a pane disappears — no watcher can
	// file the child as `cancelled` instead of `interrupted`. Herdr's relay
	// resolves as soon as the sends are issued, so its timing is unchanged.
	// Closing stays best effort: a pane that is already gone is not an error, and
	// a failure to close one changes neither the result nor the operator's notices.
	//
	// `forwarded` is what stops a second relay: the initial `aborted` check and the
	// listener can both reach here, and an abort can only send one Esc.
	let forwarded: Promise<void> | null = null;
	const forward = (): void => {
		if (forwarded) return;
		const paneIds = columns.trackedIds();
		forwarded = relayInterrupt(paneIds).then(() => {
			for (const controller of controllers) controller.abort("interrupt");
			for (const paneId of paneIds) {
				columns.drop(paneId);
				const child = paneChild(paneId);
				void child.supervisor.close(child);
			}
		});
	};
	signal?.addEventListener("abort", forward, { once: true });
	// An abort that landed before this wait was reached still relays: the listener
	// would never fire for it.
	if (signal?.aborted) forward();

	try {
		live?.start();
		const results = await Promise.all(
			runnings.map(async (running, index) => {
				const controller = controllers[index];
				const child = children[index] ?? null;
				const stopOutput = stops[index] ?? (() => {});
				const outcome = await waitForSubagent(running, controller?.signal);
				stopOutput();
				if (controller) watchers.delete(controller);
				// A wait that ended because the child is over closes its pane: a report and a
				// session exit are both the child leaving, so nothing is left to read there.
				// A turn-end completion is different — the child is alive at its prompt with no
				// summary to hand back, so the pane is the only evidence of what it did and is
				// deliberately left open. A failure or a cancellation is left on screen too:
				// there is a reason to read. An interrupt is not closed here either: it was
				// already closed by the relay that ended it. No rebalance runs here: the layout
				// is set at spawn time and a close never revisits it.
				//
				// A child with no handle has nothing to close and nothing tracked, so the
				// pane tracking is skipped rather than addressed blindly. A child supervised
				// as a process is never in the tracker to begin with.
				if (child && outcome.kind === "completed" && outcome.via !== "turn-end") {
					columns.drop(child.id);
					void child.supervisor.close(child);
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
					sharedContext: running.sharedContext,
				} satisfies SubagentResult;
			}),
		);
		await forwarded;
		return results;
	} finally {
		// The report is the result now: the live lines go with the frame that drew
		// them. The empty view is sent before this function returns, so a host never
		// has to guess that a finished call means the old lines are stale.
		live?.clear();
		signal?.removeEventListener("abort", forward);
		for (const controller of controllers) watchers.delete(controller);
	}
}
