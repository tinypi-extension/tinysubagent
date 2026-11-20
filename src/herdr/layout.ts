/**
 * Compatibility re-exports of the host-neutral layout planner.
 *
 * The planner now lives behind the pane-host seam; herdr-specific callers that
 * still import it from here get the same class and the same pure functions.
 */

export { LiveSubPanes, planPlacement, planResizes } from "../pane-host/layout.ts";
export type { Placement } from "../pane-host/layout.ts";
export type { Rect, ResizeOp } from "../pane-host/types.ts";
