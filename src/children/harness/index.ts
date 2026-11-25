/**
 * Harness resolution: which `ChildHarness` a profile runs on.
 *
 * The config loader drops unknown `harness` values at load time (fail closed),
 * so by the time a profile reaches here its harness is `pi`, `agy` or absent —
 * and absent means pi, the same default the loader applies.
 */

import type { HarnessId, LaunchMode } from "./types.ts";
import { piHarness } from "./pi.ts";
import { agyHarness } from "./agy.ts";
import type { ChildHarness } from "./types.ts";

export { piHarness } from "./pi.ts";
export type { ChildHarness, HarnessArgvSpec, HarnessId, LaunchMode, TurnInfo } from "./types.ts";

/** The harness a profile resolves to. Only `agy` profiles name one explicitly. */
export function harnessFor(profile: { harness?: HarnessId }): ChildHarness {
	switch (profile.harness) {
		case "agy":
			return agyHarness;
		default:
			return piHarness;
	}
}

/**
 * Whether this profile can run under `mode`. A pane host can run every harness —
 * an interactive child is exactly what a pane is for — so only a plain terminal
 * has anything to decide, and the harness answers it.
 */
export function harnessRunsIn(profile: { harness?: HarnessId }, mode: LaunchMode): boolean {
	return mode === "pane" || harnessFor(profile).runsHeadless;
}
