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
	tabId: string | null;
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
			tabId: typeof record.window_id === "string" ? record.window_id : null,
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
	return window ? { tabId: window.tabId, panes: window.panes } : null;
}

/** Split the orchestrator's block and return the new block's full id. */
async function rexOpenChild(
	env: NodeJS.ProcessEnv,
	{ cwd, targetPaneId, direction, command, label, focus }: OpenChildRequest,
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
		command,
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
		resizeChild: async (_op: ResizeOp) => false,
		relayInterrupt: () => {},
	};
}
