/** The Rex adapter behind the pane-host seam. */

import {
	isInsideRex,
	parseRexJson,
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

/** Type one Esc into a block; even a block that just vanished is not an error. */
function rexSendEsc(env: NodeJS.ProcessEnv, paneId: string): void {
	void runRexQuiet(["send-key", ...scopeArgs(env), "-b", paneId, "esc"]);
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
		readLayout: async (): Promise<PaneLayout | null> => null,
		resizeChild: async (_op: ResizeOp) => false,
		relayInterrupt: (paneIds) => {
			for (const paneId of paneIds) rexSendEsc(env, paneId);
		},
	};
}
