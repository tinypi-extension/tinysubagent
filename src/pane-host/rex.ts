/** The Rex adapter behind the pane-host seam. */

import type {
	CapabilityCheck,
	OpenChildRequest,
	PaneHost,
	PaneLayout,
	ProbeOptions,
	Readiness,
	ResizeOp,
} from "./types.ts";

/** Rex requires its block and session; the server is optional. */
export function isInsideRex(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.REX_BLOCK) && Boolean(env.REX_SESSION);
}

/** The block this pi is running in, used as the split anchor. */
export function currentRexBlock(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.REX_BLOCK || null;
}

function createRexCapability(): CapabilityCheck {
	const readiness: Readiness = { problem: null, fix: null };
	return {
		ensureReady: async () => readiness.problem,
		probe: async (_options?: ProbeOptions) => readiness,
		reset() {},
	};
}

export function createRexPaneHost(): PaneHost {
	return {
		kind: "rex",
		detectedIn: isInsideRex,
		currentPaneId: currentRexBlock,
		createCapability: createRexCapability,
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
