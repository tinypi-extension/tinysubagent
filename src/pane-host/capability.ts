/**
 * The readiness cache shared by both pane hosts.
 *
 * One extension registration owns one cache. A successful verdict is reused
 * for the rest of that registration; a problem is not, so a repair made in
 * place is picked up on the next check. The probe itself stays host-specific.
 */

import type { CapabilityCheck, ProbeOptions, Readiness } from "./types.ts";

export function createCapabilityCheck(
	probe: (options?: ProbeOptions) => Promise<Readiness>,
): CapabilityCheck {
	let capabilityCheck: Promise<string | null> | null = null;

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
