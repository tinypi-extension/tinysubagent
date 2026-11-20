/** The Rex adapter behind the pane-host seam. */

import { isInsideRex, rexReachable } from "../rex/cli.ts";
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

export function createRexPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	return {
		kind: "rex",
		detectedIn: isInsideRex,
		currentPaneId: currentRexBlock,
		createCapability: () => createRexCapability(env),
		openChild: async (_request: OpenChildRequest) => {
			throw new Error("Rex child spawn is not implemented yet.");
		},
		renameChild: async () => false,
		closeChild: async () => false,
		childExists: async () => null,
		readLayout: async (): Promise<PaneLayout | null> => null,
		resizeChild: async (_op: ResizeOp) => false,
		relayInterrupt: () => {},
	};
}
