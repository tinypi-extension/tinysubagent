/**
 * The one-step repair a pane host can offer at session start, so a first run
 * is a keypress instead of a typed command.
 *
 * Nothing is applied without confirmation: a repair can change the user's
 * global host config, so it stays their decision. Declining (or having no UI
 * to ask in) leaves the tool's own problem message as the fallback, and the
 * question is not repeated this session. The host owns the wording and the
 * command; this module only asks and applies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityCheck, Readiness } from "../pane-host/index.ts";

/**
 * Per-session guard, owned by the caller (index.ts) so the question is asked at
 * most once even though the repair flow lives here.
 */
export interface PluginFixGuard {
	value: boolean;
}

export interface PluginFixDeps {
	/** Probe to find the fix, and the reset that drops the verdict after a repair. */
	capability: Pick<CapabilityCheck, "probe" | "reset">;
	/** True once this session has been asked, or the answer recorded. */
	fixOffered: PluginFixGuard;
}

const NO_READINESS: Readiness = { problem: null, fix: null };

export async function offerPluginFix(ctx: ExtensionContext, deps: PluginFixDeps): Promise<void> {
	if (deps.fixOffered.value || !ctx.hasUI) return;

	// Bounded, and never fatal: an unreachable host must not hold up the session,
	// and the tool probe stays the authority on whether a spawn can actually run.
	const readiness = await deps.capability.probe({ timeoutMs: 5_000 }).catch(() => NO_READINESS);
	const { fix, problem } = readiness;
	if (!fix || !problem) return;
	deps.fixOffered.value = true;

	let agreed = false;
	try {
		agreed = await ctx.ui.confirm(fix.title, fix.detail);
	} catch {
		return; // No UI after all; the tool reports the problem when it is called.
	}
	if (!agreed) return;

	try {
		await fix.apply();
		// Drop the cached verdict so the next tool call re-probes instead of
		// reusing the problem it may already have cached.
		deps.capability.reset();
		ctx.ui.notify(fix.applied(), "info");
	} catch (error) {
		ctx.ui.notify(fix.failed(error), "error");
	}
}
