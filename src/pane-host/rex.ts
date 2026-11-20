/** The Rex adapter behind the pane-host seam. */

import {
	isInsideRex,
	parseRexJson,
	rexContext,
	rexReachable,
	runRex,
	runRexJson,
	runRexQuiet,
	scopeArgs,
} from "../rex/cli.ts";
import type {
	CapabilityCheck,
	OpenChildRequest,
	PaneHost,
	PaneLayout,
	ProbeOptions,
	Readiness,
	Rect,
	ResizeOp,
} from "./types.ts";

export { isInsideRex } from "../rex/cli.ts";

/** The block this pi is running in, used as the split anchor. */
export function currentRexBlock(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.REX_BLOCK || null;
}

const READY: Readiness = { problem: null, fix: null };

/** The Rex probe: context and a reachable CLI, with no version gate or fix. */
export function createRexCapability(env: NodeJS.ProcessEnv = process.env): CapabilityCheck {
	let capabilityCheck: Promise<string | null> | null = null;

	async function probe(options: ProbeOptions = {}): Promise<Readiness> {
		if (!isInsideRex(env)) {
			return {
				problem: "Rex block and session context is missing — start pi inside a Rex block.",
				fix: null,
			};
		}
		if (!(await rexReachable(options))) {
			return {
				problem: "rex is not reachable from this block — install it on PATH.",
				fix: null,
			};
		}
		return READY;
	}

	async function ensureReady(): Promise<string | null> {
		capabilityCheck ??= probe().then((readiness) => readiness.problem);
		const problem = await capabilityCheck;
		if (problem) capabilityCheck = null;
		return problem;
	}

	return {
		ensureReady,
		probe,
		reset: () => {
			capabilityCheck = null;
		},
	};
}

/** A missing block is a definite "no"; every other failure is unknown. */
async function rexChildExists(env: NodeJS.ProcessEnv, paneId: string): Promise<boolean | null> {
	try {
		const text = await runRex(["block", "inspect", ...scopeArgs(env), paneId, "--json"]);
		return parseRexJson(text) !== null;
	} catch (error) {
		return /not found|no such|does not exist|unknown block/i.test(String(error)) ? false : null;
	}
}

async function rexCloseChild(env: NodeJS.ProcessEnv, paneId: string): Promise<boolean> {
	return runRexQuiet(["block", "close", ...scopeArgs(env), paneId]);
}

async function rexRenameChild(env: NodeJS.ProcessEnv, paneId: string, label: string): Promise<boolean> {
	return runRexQuiet(["block", "rename", ...scopeArgs(env), paneId, label]);
}

interface RexView {
	windowId: string | null;
	panes: { paneId: string; rect: Rect }[];
	layers: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Rex reports rects as `[x, y, width, height]` fractions of the window. */
function rexRect(value: unknown): Rect | null {
	if (!Array.isArray(value) || value.length !== 4) return null;
	const [x, y, width, height] = value;
	if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) {
		return null;
	}
	return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/** Flatten one Rex layout tree into the seam's normalized pane list. */
function collectRexPanes(node: unknown, panes: RexView["panes"], ids: Set<string>): void {
	const record = asRecord(node);
	if (!record) return;
	if (typeof record.block_id === "string") {
		ids.add(record.block_id);
		const rect = rexRect(record.rect);
		if (rect) panes.push({ paneId: record.block_id, rect });
	}
	const split = asRecord(record.split);
	if (split) {
		collectRexPanes(split.before, panes, ids);
		collectRexPanes(split.after, panes, ids);
	}
}

/**
 * The window that contains `paneId`. A block in a different window is not part
 * of this tab's layout, even when the session reports several windows.
 */
function rexWindow(view: Record<string, unknown>, paneId: string): RexView | null {
	const windows = Array.isArray(view.windows) ? view.windows : [];
	for (const entry of windows) {
		const record = asRecord(entry);
		if (!record) continue;
		const layers = Array.isArray(record.layers) ? record.layers : [];
		const panes: RexView["panes"] = [];
		const ids = new Set<string>();
		for (const layer of layers) {
			const layerRecord = asRecord(layer);
			if (layerRecord && layerRecord.kind === "tiled") {
				collectRexPanes(layerRecord.layout, panes, ids);
			}
		}
		if (!ids.has(paneId)) continue;
		return {
			windowId: typeof record.window_id === "string" ? record.window_id : null,
			panes,
			layers,
		};
	}
	return null;
}

/**
 * Read the session view. `session inspect` takes the session as a positional
 * argument, so only the server is pinned here; the session is already in the
 * command itself.
 */
async function readRexSession(env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null> {
	const { session, server } = rexContext(env);
	if (!session) return null;
	const args = [
		"session",
		"inspect",
		...(server ? ["-S", server] : []),
		session,
		"--json",
	];
	try {
		return parseRexJson(await runRex(args));
	} catch {
		return null;
	}
}

async function rexReadLayout(
	env: NodeJS.ProcessEnv,
	paneId: string,
): Promise<PaneLayout | null> {
	const view = await readRexSession(env);
	if (!view) return null;
	const window = rexWindow(view, paneId);
	// Rex rects are fractions of a window, not rows: a whole-row tolerance would
	// swallow every meaningful adjustment.
	return window ? { windowId: window.windowId, panes: window.panes, tolerance: 1e-6 } : null;
}

type PaneRect = RexView["panes"][number];
type Axis = "horizontal" | "vertical";

const EPSILON = 1e-6;

function spansOverlap(
	paneStart: number,
	paneSize: number,
	otherStart: number,
	otherSize: number,
): boolean {
	return Math.min(paneStart + paneSize, otherStart + otherSize) - Math.max(paneStart, otherStart) > EPSILON;
}

/** The pane touching `pane` across the divider on the given axis, if any. */
function adjacentPane(panes: PaneRect[], pane: PaneRect, axis: Axis): PaneRect | null {
	let best: PaneRect | null = null;
	let bestOverlap = 0;
	for (const candidate of panes) {
		if (candidate.paneId === pane.paneId) continue;
		const overlap = axis === "horizontal"
			? spansOverlap(pane.rect.y, pane.rect.height, candidate.rect.y, candidate.rect.height)
				? Math.min(pane.rect.height, candidate.rect.height)
				: 0
			: spansOverlap(pane.rect.x, pane.rect.width, candidate.rect.x, candidate.rect.width)
				? Math.min(pane.rect.width, candidate.rect.width)
				: 0;
		if (overlap <= EPSILON || overlap <= bestOverlap) continue;
		const touches = axis === "horizontal"
			? Math.abs(candidate.rect.x + candidate.rect.width - pane.rect.x) < EPSILON ||
				Math.abs(pane.rect.x + pane.rect.width - candidate.rect.x) < EPSILON
			: Math.abs(candidate.rect.y + candidate.rect.height - pane.rect.y) < EPSILON ||
				Math.abs(pane.rect.y + pane.rect.height - candidate.rect.y) < EPSILON;
		if (!touches) continue;
		best = candidate;
		bestOverlap = overlap;
	}
	return best;
}

function blockIds(node: unknown, into: Set<string>): void {
	const record = asRecord(node);
	if (!record) return;
	if (typeof record.block_id === "string") into.add(record.block_id);
	const split = asRecord(record.split);
	if (split) {
		blockIds(split.before, into);
		blockIds(split.after, into);
	}
}

/** The Rex split ratio for the border that separates the two given blocks. */
function splitRatio(node: unknown, beforeId: string, afterId: string, axis: Axis): number | null {
	const record = asRecord(node);
	if (!record) return null;
	const split = asRecord(record.split);
	if (!split) return null;

	if (split.direction === axis) {
		const before = new Set<string>();
		const after = new Set<string>();
		blockIds(split.before, before);
		blockIds(split.after, after);
		if (before.has(beforeId) && after.has(afterId)) {
			// The innermost matching split is the border Rex's resize API will pick.
			const deeper = splitRatio(split.before, beforeId, afterId, axis) ??
				splitRatio(split.after, beforeId, afterId, axis);
			if (deeper !== null) return deeper;
			return typeof split.ratio === "number" && Number.isFinite(split.ratio) ? split.ratio : null;
		}
	}
	return splitRatio(split.before, beforeId, afterId, axis) ??
		splitRatio(split.after, beforeId, afterId, axis);
}

async function rexResizeChild(env: NodeJS.ProcessEnv, op: ResizeOp): Promise<boolean> {
	const axis: Axis | null = op.direction === "left" || op.direction === "right"
		? "horizontal"
		: op.direction === "up" || op.direction === "down"
			? "vertical"
			: null;
	if (!axis) return false;

	const view = await readRexSession(env);
	if (!view) return false;
	const window = rexWindow(view, op.paneId);
	if (!window) return false;
	const pane = window.panes.find((entry) => entry.paneId === op.paneId);
	if (!pane) return false;
	const neighbor = adjacentPane(window.panes, pane, axis);
	if (!neighbor) return false;

	// `before` is the left/top side of the border regardless of which pane the
	// planner named: the planner's direction says which way the border moves.
	const neighborFirst = axis === "horizontal"
		? neighbor.rect.x < pane.rect.x
		: neighbor.rect.y < pane.rect.y;
	const beforeId = neighborFirst ? neighbor.paneId : pane.paneId;
	const afterId = neighborFirst ? pane.paneId : neighbor.paneId;
	let ratio: number | null = null;
	for (const layer of window.layers) {
		const record = asRecord(layer);
		if (!record || record.kind !== "tiled") continue;
		ratio = splitRatio(record.layout, beforeId, afterId, axis);
		if (ratio !== null) break;
	}
	if (ratio === null) return false;

	const growsBefore = op.direction === "right" || op.direction === "down";
	const target = ratio + (growsBefore ? op.amount : -op.amount);
	if (!Number.isFinite(target) || target <= 0 || target >= 1) return false;

	const { session, server } = rexContext(env);
	if (!session) return false;
	return runRexQuiet([
		"api",
		"call",
		"-s",
		session,
		...(server ? ["-S", server] : []),
		"session.resize_pane",
		JSON.stringify({
			session_id: session,
			direction: axis,
			before_block_id: beforeId,
			after_block_id: afterId,
			ratio: target,
		}),
	]);
}

/** Type one Esc into a block; even a block that just vanished is not an error. */
function rexSendEsc(env: NodeJS.ProcessEnv, paneId: string): void {
	void runRexQuiet(["send-key", ...scopeArgs(env), "-b", paneId, "esc"]);
}

/** Split the orchestrator's block and return the new block's full id. */
async function rexOpenChild(
	env: NodeJS.ProcessEnv,
	{ cwd, targetPaneId, direction, scriptPath, label, focus }: OpenChildRequest,
): Promise<string> {
	const anchor = targetPaneId ?? currentRexBlock(env);
	if (!anchor) throw new Error("Rex block context is missing — cannot split a child block.");

	const args = [
		"split",
		...scopeArgs(env),
		"-b",
		anchor,
		"--split",
		direction === "right" ? "right" : "below",
		// One child: the orchestrator keeps three fifths, the column gets two.
		"--ratio",
		"40",
		"-c",
		cwd,
		"--keep-open",
		...(label ? ["--label", label] : []),
		focus ? "--focus" : "--focus=false",
		"--json",
		"--",
		scriptPath,
	];
	const result = await runRexJson(args, { timeoutMs: 30_000 });
	const ids = result.block_ids;
	const blockId = Array.isArray(ids) ? ids[0] : result.block_id;
	if (typeof blockId !== "string" || blockId === "") {
		throw new Error(`rex split reported no block id (${JSON.stringify(result)}).`);
	}
	return blockId;
}

export function createRexPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	return {
		kind: "rex",
		detectedIn: isInsideRex,
		currentPaneId: currentRexBlock,
		createCapability: () => createRexCapability(env),
		openChild: (request) => rexOpenChild(env, request),
		renameChild: (paneId, label) => rexRenameChild(env, paneId, label),
		closeChild: (paneId) => rexCloseChild(env, paneId),
		childExists: (paneId) => rexChildExists(env, paneId),
		readLayout: (paneId) => rexReadLayout(env, paneId),
		resizeChild: (op) => rexResizeChild(env, op),
		relayInterrupt: (paneIds) => {
			for (const paneId of paneIds) rexSendEsc(env, paneId);
		},
	};
}
