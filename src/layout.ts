/**
 * Orchestrator-first panel geometry: where the next sub pane goes, and how the
 * column it lands in is resized to fit.
 *
 * The module's rule, in one line: **the orchestrator keeps 3/5 of its rect, and
 * every live subagent shares one right-hand column divided equally.**
 *
 * Three intent decisions are baked in here and must not drift:
 *
 *   1. A sub pane closing does **not** rebalance the survivors. Nothing in this
 *      module reacts to a close; the layout is set once, at spawn time.
 *   2. A later spawn **joins the live column** and re-divides every live sub
 *      equally — "N subs" means all live sub panes in this tab, not one batch.
 *   3. The 3/5 pass fires **only at column birth**. A divider the user dragged by
 *      hand is never snapped back on a later spawn.
 *
 * This file does no I/O. It never spawns a process, reads the environment, the
 * filesystem or the clock, and it exports only pure functions plus one in-memory
 * set. Every measurement comes from a `TabLayout` the caller already read.
 */

import type { Rect, TabLayout } from "./herdr.ts";

/** One divider move, as `herdr pane resize` takes it. */
export interface ResizeOp {
	paneId: string;
	direction: "left" | "right" | "up" | "down";
	amount: number; // fraction of the split node's rect
}

/** Where the next pane goes, and what to do once it is open. */
export interface Placement {
	targetPaneId: string; // split target
	direction: "right" | "down";
	bornColumn: boolean; // the 3/5 pass applies
}

/** A pane and its rect, as recovered from a possibly-garbage layout. */
interface MeasuredPane {
	paneId: string;
	rect: Rect;
}

/**
 * Recover the usable panes from a layout, whatever shape it arrived in. A
 * missing pane list, a non-string id or a non-numeric rect is dropped rather
 * than trusted: an unmeasurable rect would otherwise poison every delta.
 */
function measuredPanes(layout: TabLayout | null | undefined): MeasuredPane[] {
	const raw = layout && Array.isArray(layout.panes) ? layout.panes : [];
	const panes: MeasuredPane[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const pane = entry as { paneId?: unknown; rect?: unknown };
		if (typeof pane.paneId !== "string") continue;
		const rect = pane.rect as Record<string, unknown> | null | undefined;
		if (!rect || typeof rect !== "object") continue;
		const { x, y, width, height } = rect;
		if (![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))) {
			continue;
		}
		panes.push({ paneId: pane.paneId, rect: { x, y, width, height } as Rect });
	}
	return panes;
}

/** The tracked ids that the tab actually reports, ordered top to bottom. */
function liveInTab(panes: MeasuredPane[], live: readonly string[]): MeasuredPane[] {
	const tracked = new Set(Array.isArray(live) ? live : []);
	return panes
		.filter((pane) => tracked.has(pane.paneId))
		.sort((a, b) => a.rect.y - b.rect.y);
}

/**
 * Decide where the next pane is split in, before it is opened.
 *
 * A non-empty live column appends downward to its bottom-most pane; otherwise
 * this is a column birth and the pane splits right off the orchestrator. A live
 * id the tab does not report is ignored, so a stale tracker entry can never be
 * chosen as a split target. Total: any input yields the birth placement.
 */
export function planPlacement(
	layout: TabLayout,
	orchestratorPaneId: string,
	live: readonly string[],
): Placement {
	const birth: Placement = { targetPaneId: orchestratorPaneId, direction: "right", bornColumn: true };
	const inTab = liveInTab(measuredPanes(layout), live);
	if (inTab.length === 0) return birth;

	// max rect.y, not last-in-array: pane order in the payload is not a contract.
	let bottom = inTab[0];
	if (!bottom) return birth;
	for (const pane of inTab) {
		if (pane.rect.y > bottom.rect.y) bottom = pane;
	}
	return { targetPaneId: bottom.paneId, direction: "down", bornColumn: false };
}

/**
 * Compute the resize pass for the column the new pane just joined.
 *
 * Birth is `inTab === [newPaneId]` — the same "is there a live column?" test
 * `planPlacement` uses, narrowed to the single case where the column really did
 * not exist before. Anything larger is an append over the whole column.
 *
 * Both cases are guarded by a one-row tolerance because herdr rounds every
 * resize to whole rows, so a pass that is already equal emits nothing. Total:
 * any input yields `[]`, and the pass never exceeds `N-1` ops.
 */
export function planResizes(
	layout: TabLayout,
	orchestratorPaneId: string,
	live: readonly string[],
	newPaneId: string,
): ResizeOp[] {
	const panes = measuredPanes(layout);
	if (!panes.some((pane) => pane.paneId === newPaneId)) return [];
	const inTab = liveInTab(panes, live);
	if (inTab.length === 0) return [];

	const only = inTab.length === 1 ? inTab[0] : undefined;
	if (only && only.paneId === newPaneId) {
		// Column birth: pull the root divider until the orchestrator holds 3/5.
		const orches = panes.find((pane) => pane.paneId === orchestratorPaneId);
		if (!orches) return [];
		const width = orches.rect.width + only.rect.width;
		if (width === 0) return [];
		const delta = orches.rect.width - 0.6 * width;
		if (Math.abs(delta) < 1) return [];
		return [
			{
				paneId: newPaneId,
				direction: delta > 0 ? "left" : "right",
				amount: Math.abs(delta) / width,
			},
		];
	}

	// Append: walk the boundaries top-down, equalising one at a time. Because
	// everything above boundary k is already at target, the split node spanning
	// pane_k..pane_N is C - (k-1)·t tall, and the op's amount must be measured
	// against that shrinking node rather than the original column height.
	const count = inTab.length;
	const total = inTab.reduce((sum, pane) => sum + pane.rect.height, 0);
	const target = total / count;
	const ops: ResizeOp[] = [];
	for (let k = 1; k < count; k += 1) {
		const above = inTab[k - 1];
		const below = inTab[k];
		if (!above || !below) continue;
		const delta = above.rect.height - target;
		if (Math.abs(delta) < 1) continue;
		const nodeHeight = total - (k - 1) * target;
		if (nodeHeight === 0) continue;
		ops.push({
			paneId: below.paneId,
			direction: delta > 0 ? "up" : "down",
			amount: Math.abs(delta) / nodeHeight,
		});
	}
	return ops;
}

/**
 * The sub panes this extension opened, tracked in memory for one extension
 * registration.
 *
 * `liveIn` treats the tab's own pane list as the oracle: an id we tracked but
 * the tab no longer reports was closed by someone else, so it is pruned there
 * instead of via a `pane get` probe per pane. That prune is what stops a
 * user-closed pane from being chosen as a later split target.
 */
export class LiveSubPanes {
	private readonly tracked = new Set<string>();

	/** Record a pane id we successfully opened. Idempotent. */
	place(paneId: string): void {
		this.tracked.add(paneId);
	}

	/** Forget a pane id. Unknown ids are ignored. */
	drop(paneId: string): void {
		this.tracked.delete(paneId);
	}

	/** Tracked panes the tab still reports, ordered top to bottom. */
	liveIn(tab: TabLayout): string[] {
		const panes = measuredPanes(tab);
		const reported = new Set(panes.map((pane) => pane.paneId));
		for (const id of [...this.tracked]) {
			if (!reported.has(id)) this.tracked.delete(id);
		}
		return panes
			.filter((pane) => this.tracked.has(pane.paneId))
			.sort((a, b) => a.rect.y - b.rect.y)
			.map((pane) => pane.paneId);
	}
}
