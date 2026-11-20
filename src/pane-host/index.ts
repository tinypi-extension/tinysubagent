/**
 * The pane-host seam.
 *
 * Everything this extension does to a pane goes through the host-neutral
 * operations on {@link PaneHost}. The adapter behind them is chosen here, so
 * callers never read a host's environment variables or speak its CLI.
 */

import { createHerdrPaneHost } from "./herdr.ts";
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

/** Build an adapter. Host selection lives here, never at a call site. */
export function createPaneHost(_env: NodeJS.ProcessEnv = process.env): PaneHost {
	return createHerdrPaneHost();
}

/** The adapter shared by this extension instance. */
export const paneHost: PaneHost = createPaneHost();

/** Which host, if any, owns this pi process. */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHostKind | null {
	return paneHost.detectedIn(env) ? paneHost.kind : null;
}
