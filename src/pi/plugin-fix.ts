/**
 * The one-step herdr plugin repair offered at session start, so a first run is
 * a keypress instead of a path-typed command.
 *
 * Nothing is linked or enabled without the confirmation: this mutates the
 * user's global herdr config, so it stays a decision they make. Declining (or
 * having no UI to ask in) leaves the tool's own error message as the fallback,
 * and the question is not repeated this session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdrPluginEnable, herdrPluginLink, PLUGIN_ID, pluginDir } from "../herdr/cli.ts";
import type { CapabilityCheck } from "./capability.ts";

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

export async function offerPluginFix(ctx: ExtensionContext, deps: PluginFixDeps): Promise<void> {
	if (deps.fixOffered.value || !ctx.hasUI) return;

	// Bounded, and never fatal: a wedged herdr must not hold up the session, and
	// the tool probe stays the authority on whether a spawn can actually run.
	const readiness = await deps.capability.probe({ timeoutMs: 5_000 }).catch(() => null);
	const fix = readiness?.fix;
	const problem = readiness?.problem;
	if (!fix || !problem) return;
	deps.fixOffered.value = true;

	const pluginDirPath = pluginDir();
	const title = fix === "link" ? "Link the tinysubagent herdr plugin?" : "Enable the tinysubagent herdr plugin?";
	const detail =
		fix === "link"
			? `The pane entrypoint "${PLUGIN_ID}" ships with this package but is not linked yet.\n\n` +
				`herdr plugin link "${pluginDirPath}" --enabled`
			: `The pane entrypoint "${PLUGIN_ID}" is linked but disabled.\n\n` + `herdr plugin enable ${PLUGIN_ID}`;

	let agreed = false;
	try {
		agreed = await ctx.ui.confirm(title, detail);
	} catch {
		return; // No UI after all; the tool reports the problem when it is called.
	}
	if (!agreed) return;

	try {
		if (fix === "link") await herdrPluginLink(pluginDirPath);
		else await herdrPluginEnable(PLUGIN_ID);
		// Drop the cached verdict so the next tool call re-probes instead of
		// reusing the "not installed" answer it may already have.
		deps.capability.reset();
		ctx.ui.notify(`tinysubagent: ${PLUGIN_ID} is ready.`, "info");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const verb = fix === "link" ? "link" : "enable";
		ctx.ui.notify(`tinysubagent: could not ${verb} ${PLUGIN_ID}: ${reason}`, "error");
	}
}
