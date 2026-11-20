/**
 * The pane-host seam.
 *
 * Everything this extension does to a pane goes through the host-neutral
 * operations on {@link PaneHost}. The adapter behind them is chosen here, so
 * callers never read a host's environment variables or speak its CLI.
 */

import { createHerdrPaneHost } from "./herdr.ts";
import { createRexPaneHost } from "./rex.ts";
import type { PaneHost, PaneHostKind } from "./types.ts";

export { LiveSubPanes, planPlacement, planResizes } from "./layout.ts";
export type { Placement } from "./layout.ts";

export type {
	CapabilityCheck,
	HostFix,
	OpenChildRequest,
	PaneHost,
	PaneHostKind,
	PaneLayout,
	ProbeOptions,
	Readiness,
	Rect,
	ResizeOp,
} from "./types.ts";

const herdr = createHerdrPaneHost();
const rex = createRexPaneHost();

/** Host selection lives here, never at a call site. Herdr wins a mixed env. */
function select(env: NodeJS.ProcessEnv): PaneHost {
	if (herdr.detectedIn(env)) return herdr;
	if (rex.detectedIn(env)) return rex;
	// With no host detected, keep herdr as the default adapter. Callers still
	// refuse to register the tool; this only preserves the seam's old shape.
	return herdr;
}

/** A seam whose adapter is resolved from `env` for every operation. */
function routed(env: () => NodeJS.ProcessEnv): PaneHost {
	const host = (): PaneHost => select(env());
	return {
		get kind() {
			return host().kind;
		},
		detectedIn(candidate) {
			return herdr.detectedIn(candidate) || rex.detectedIn(candidate);
		},
		currentPaneId: (candidate) => host().currentPaneId(candidate),
		createCapability: () => host().createCapability(),
		openChild: (request) => host().openChild(request),
		renameChild: (paneId, label) => host().renameChild(paneId, label),
		closeChild: (paneId) => host().closeChild(paneId),
		childExists: (paneId) => host().childExists(paneId),
		readLayout: (paneId) => host().readLayout(paneId),
		resizeChild: (op) => host().resizeChild(op),
		relayInterrupt: (paneIds) => host().relayInterrupt(paneIds),
	};
}

/** Build a seam bound to one environment. */
export function createPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	return routed(() => env);
}

/**
 * The environment whose host owns this extension registration. It starts empty
 * so direct seam consumers keep the herdr passthrough until the extension says
 * otherwise, even when the surrounding shell happens to be a Rex block.
 */
let activeEnv: NodeJS.ProcessEnv = {};

/** Choose the adapter for one extension registration. */
export function activatePaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	activeEnv = env;
	return select(env);
}

/** The seam used by the extension's spawn, watch and interrupt call sites. */
export const paneHost: PaneHost = routed(() => activeEnv);

/** Which host, if any, owns this pi process. */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHostKind | null {
	return herdr.detectedIn(env) || rex.detectedIn(env) ? select(env).kind : null;
}
