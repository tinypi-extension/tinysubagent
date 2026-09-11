/**
 * The herdr capability probe, cached for the lifetime of one registration.
 *
 * The probe answers two questions at once — "can a spawn run?" and, when it
 * cannot, "is there a one-step fix?" — so the session hook can offer the fix
 * without disturbing the verdict the tool caches. The cache lives in the
 * factory closure rather than at module scope, so no two registrations share it.
 */

import {
	herdrPluginInfo,
	herdrStatus,
	MIN_HERDR_VERSION,
	PLUGIN_ID,
	pluginDir,
	type RunOptions,
	versionAtLeast,
} from "../herdr/cli.ts";

/** What the probe found, and whether the session hook can offer a one-step fix. */
export interface HerdrReadiness {
	/** The message the tool reports; null when everything is in place. */
	problem: string | null;
	/** The fix the user can be asked to approve, when there is one. */
	fix: "link" | "enable" | null;
}

const READY: HerdrReadiness = { problem: null, fix: null };

/** The probe, plus the cached verdict the tool wants. */
export interface CapabilityCheck {
	/** Cached verdict: the problem string, or null when everything is in place. */
	ensureReady(): Promise<string | null>;
	/** The full probe, for the session hook's "what is wrong, and can I fix it?". */
	probe(options?: RunOptions): Promise<HerdrReadiness>;
	/** Drop the cached verdict so the next call re-probes. */
	reset(): void;
}

export function createCapabilityCheck(): CapabilityCheck {
	let capabilityCheck: Promise<string | null> | null = null;

	/**
	 * The full capability probe, kept separate from the cached verdict so the session
	 * hook can ask "what is wrong, and can I offer to fix it?" without disturbing it.
	 */
	async function probe(options: RunOptions = {}): Promise<HerdrReadiness> {
		const status = await herdrStatus(options);
		if (!status?.running) {
			return {
				problem: "herdr is not reachable from this pane — is the herdr server still running?",
				fix: null,
			};
		}
		if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
			return {
				problem: `herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes (found ${status.version ?? "unknown"}). Update herdr and restart its session.`,
				fix: null,
			};
		}
		const plugin = await herdrPluginInfo(PLUGIN_ID, options);
		if (!plugin) {
			return {
				problem: `the herdr plugin "${PLUGIN_ID}" is not installed. Run: herdr plugin link "${pluginDir()}" --enabled`,
				fix: "link",
			};
		}
		if (!plugin.enabled) {
			return {
				problem: `the herdr plugin "${PLUGIN_ID}" is disabled. Run: herdr plugin enable ${PLUGIN_ID}`,
				fix: "enable",
			};
		}
		return READY;
	}

	async function checkHerdr(): Promise<string | null> {
		return (await probe()).problem;
	}

	/**
	 * Cached capability probe. A failure is not cached, so fixing herdr in place
	 * (linking or enabling the plugin) is picked up by the next call without a
	 * reload.
	 */
	async function ensureReady(): Promise<string | null> {
		capabilityCheck ??= checkHerdr();
		const problem = await capabilityCheck;
		if (problem) capabilityCheck = null;
		return problem;
	}

	function reset(): void {
		capabilityCheck = null;
	}

	return { ensureReady, probe, reset };
}
