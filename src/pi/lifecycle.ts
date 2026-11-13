/**
 * Session subscriptions: the hooks that run at the edges of a session.
 *
 * Deliberately not named `session.ts` — that name belongs to the child's JSONL
 * reader. Registration order matches the original index.ts: start first, then
 * shutdown, both before the tool is registered.
 *
 * Shutdown aborts every running watcher, which is also what ends a blocking tool
 * call: the call returns its batch as cancelled rather than outliving the session
 * that asked for it. The children's panes are left open.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface LifecycleDeps {
	/** Config problems to surface once, at session start. */
	configWarnings: readonly string[];
	/** The one-step plugin repair offer, bound to the capability probe. */
	offerPluginFix: (ctx: ExtensionContext) => Promise<void>;
	/** Watchers still running, aborted and cleared on shutdown; owned by the caller. */
	watchers: Set<AbortController>;
}

export function registerLifecycle(pi: ExtensionAPI, deps: LifecycleDeps): void {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (deps.configWarnings.length > 0) {
			try {
				ctx.ui.notify(deps.configWarnings.join("\n"), "warning");
			} catch {
				// A notification is not worth failing a session for.
			}
		}
		return deps.offerPluginFix(ctx);
	});

	pi.on("session_shutdown", () => {
		for (const watcher of deps.watchers) watcher.abort();
		deps.watchers.clear();
	});
}
