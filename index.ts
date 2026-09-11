/**
 * tinysubagent — delegate work to subagents running in herdr panes.
 *
 * A spawn is fire-and-forget: the tool opens one pane per task and returns an
 * acknowledgement, then a detached watcher collects each child's final assistant
 * message and delivers it back to this session as a steer message. For a batch,
 * every child's result arrives together in one labelled message.
 *
 * The tool is only registered when this pi is itself running inside herdr. That
 * is a deliberate choice over registering-and-failing: outside herdr there is no
 * pane to split, so offering the tool would only invite calls that cannot work.
 *
 * Only three things leave the orchestrator's process: the launch script it
 * writes, the `herdr plugin pane open` call that runs it, and the poll that
 * notices when the child is done. Everything else is a file on disk.
 *
 * This file is wiring only. The tool definition lives in `src/pi/tool.ts`, the
 * session hooks in `src/pi/lifecycle.ts`, and the per-registration state below
 * is what those two share.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./src/config/agents.ts";
import { loadConfig } from "./src/config/config.ts";
import { isInsideHerdr } from "./src/herdr/cli.ts";
import { LiveSubPanes } from "./src/herdr/layout.ts";
import { buildParameters } from "./src/present/describe.ts";
import { createCapabilityCheck } from "./src/pi/capability.ts";
import { registerLifecycle } from "./src/pi/lifecycle.ts";
import { offerPluginFix, type PluginFixGuard } from "./src/pi/plugin-fix.ts";
import { createTool } from "./src/pi/tool.ts";

export default function tinysubagent(pi: ExtensionAPI): void {
	if (!isInsideHerdr()) return;

	const { config, warnings: configWarnings } = loadConfig(process.cwd(), getAgentDir());
	const parameters = buildParameters(config);
	// Roles are advertised at registration time, when there is no session context
	// yet — the process cwd is the best available answer.
	const advertisedAgents = discoverAgents(process.cwd()).agents;

	/** Watchers still running, so a shutdown can end them. */
	const watchers = new Set<AbortController>();
	let shuttingDown = false;

	/** Asked once per session — a second prompt would only nag. */
	const fixOffered: PluginFixGuard = { value: false };

	/** Cached capability probe for this registration. */
	const capability = createCapabilityCheck();

	/**
	 * The sub panes this registration opened, tracked for the layout planner. One
	 * instance per registration: the spawn recipe reads it to decide birth-vs-
	 * append and prunes it against the tab, and the completion close drops from it.
	 */
	const columns = new LiveSubPanes();

	const pluginFix = (ctx: ExtensionContext) => offerPluginFix(ctx, { capability, fixOffered });

	registerLifecycle(pi, {
		configWarnings,
		offerPluginFix: pluginFix,
		watchers,
		markShuttingDown: () => {
			shuttingDown = true;
		},
	});

	pi.registerTool(
		createTool({
			pi,
			config,
			parameters,
			advertisedAgents,
			capability,
			columns,
			watchers,
			isShuttingDown: () => shuttingDown,
		}),
	);
}
