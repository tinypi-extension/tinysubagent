/** The herdr adapter behind the pane-host seam. */

import {
	currentPaneId,
	herdrPaneClose,
	herdrPaneExists,
	herdrPaneLayout,
	herdrPaneOpen,
	herdrPaneRename,
	herdrPaneResize,
	herdrPaneSendEsc,
	herdrPluginEnable,
	herdrPluginInfo,
	herdrPluginLink,
	herdrStatus,
	isInsideHerdr,
	MIN_HERDR_VERSION,
	PLUGIN_ID,
	pluginDir,
	versionAtLeast,
} from "../herdr/cli.ts";
import type {
	CapabilityCheck,
	HostFix,
	OpenChildRequest,
	PaneHost,
	ProbeOptions,
	Readiness,
	ResizeOp,
} from "./types.ts";

const READY: Readiness = { problem: null, fix: null };

function linkFix(): HostFix {
	const path = pluginDir();
	return {
		title: "Link the tinysubagent herdr plugin?",
		detail:
			`The pane entrypoint "${PLUGIN_ID}" ships with this package but is not linked yet.\n\n` +
			`herdr plugin link "${path}" --enabled`,
		apply: () => herdrPluginLink(path),
		applied: () => `tinysubagent: ${PLUGIN_ID} is ready.`,
		failed: (error) => {
			const reason = error instanceof Error ? error.message : String(error);
			return `tinysubagent: could not link ${PLUGIN_ID}: ${reason}`;
		},
	};
}

function enableFix(): HostFix {
	return {
		title: "Enable the tinysubagent herdr plugin?",
		detail:
			`The pane entrypoint "${PLUGIN_ID}" is linked but disabled.\n\n` +
			`herdr plugin enable ${PLUGIN_ID}`,
		apply: () => herdrPluginEnable(PLUGIN_ID),
		applied: () => `tinysubagent: ${PLUGIN_ID} is ready.`,
		failed: (error) => {
			const reason = error instanceof Error ? error.message : String(error);
			return `tinysubagent: could not enable ${PLUGIN_ID}: ${reason}`;
		},
	};
}

/** The herdr capability probe, with its cache scoped to one registration. */
export function createHerdrCapability(): CapabilityCheck {
	let capabilityCheck: Promise<string | null> | null = null;

	async function probe(options: ProbeOptions = {}): Promise<Readiness> {
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
				fix: linkFix(),
			};
		}
		if (!plugin.enabled) {
			return {
				problem: `the herdr plugin "${PLUGIN_ID}" is disabled. Run: herdr plugin enable ${PLUGIN_ID}`,
				fix: enableFix(),
			};
		}
		return READY;
	}

	async function ensureReady(): Promise<string | null> {
		capabilityCheck ??= probe().then((readiness) => readiness.problem);
		const problem = await capabilityCheck;
		// Failures are not cached: a repair made in place is picked up next time.
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

export function createHerdrPaneHost(): PaneHost {
	return {
		kind: "herdr",
		detectedIn: isInsideHerdr,
		currentPaneId,
		createCapability: createHerdrCapability,
		openChild: ({ cwd, targetPaneId, direction, scriptPath, focus }: OpenChildRequest) =>
			herdrPaneOpen({
				cwd,
				targetPaneId,
				direction,
				// The herdr entrypoint reads the wrapper path from this --env value.
				env: { PI_HERDR_LAUNCH_SCRIPT: scriptPath },
				focus,
			}),
		renameChild: herdrPaneRename,
		closeChild: herdrPaneClose,
		childExists: herdrPaneExists,
		readLayout: (paneId) => herdrPaneLayout(paneId),
		resizeChild: ({ paneId, direction, amount }: ResizeOp) =>
			herdrPaneResize(paneId, direction, amount),
		relayInterrupt: (paneIds) => {
			for (const paneId of paneIds) void herdrPaneSendEsc(paneId).catch(() => {});
		},
	};
}
