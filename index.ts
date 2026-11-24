/**
 * tinysubagent — delegate work to subagents, each in its own place.
 *
 * A call blocks: the tool opens one child per task, waits for the whole batch, and
 * returns every child's report in that one tool result. Nothing is delivered to
 * this session afterwards, so the report is the answer rather than a later
 * message. For a batch, every child's result is carried together, one section
 * each.
 *
 * The tool is registered in every pi session. Where a pane host is detected each
 * child gets its own pane; in a plain terminal, where there is no pane to split,
 * the same child runs as a headless process instead. Detection therefore chooses
 * *how* a child is supervised, not whether delegation exists — registering and
 * failing would refuse work the plain terminal can do.
 *
 * Only four things leave the orchestrator's process: the launch script it
 * writes, the supervisor command that starts it, the poll that
 * notices when the child is done, and — only when a `systemOneAPIKey` is
 * configured — the SystemOne routing request, which carries each task brief
 * to `systemOneBaseUrl` to choose the child's profile. Everything else is a
 * file on disk.
 *
 * This file is wiring only. The tool definition lives in `src/pi/tool.ts`, the
 * session hooks in `src/pi/lifecycle.ts`, and the per-registration state below
 * is what those two share.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./src/config/agents.ts";
import { loadConfig } from "./src/config/config.ts";
import { activatePaneHost, LiveSubPanes, supervisor } from "./src/pane-host/index.ts";
import { buildParameters } from "./src/present/describe.ts";
import { registerLifecycle } from "./src/pi/lifecycle.ts";
import { offerPluginFix, type PluginFixGuard } from "./src/pi/plugin-fix.ts";
import { createTool } from "./src/pi/tool.ts";
import { createSettingsScreen } from "./src/pi/settings-tui.ts";
import { createRouteFn, type ClassifierRegistry } from "./src/systemone/route.ts";

export default function tinysubagent(pi: ExtensionAPI): void {
	// Registered first: editing a config file needs no child, so the command has to
	// exist in every pi session, whatever kind of terminal this is. The call is
	// optional so a host that offers no commands still gets the tool below it.
	pi.registerCommand?.("subagent-settings", {
		description: "Edit tinysubagent profiles (enableProfiles + profiles.<name>)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("tinysubagent: settings need interactive mode.", "warning");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
				createSettingsScreen({ ctx, theme, done: () => done(undefined) }),
			);
		},
	});

	// Detection chooses the kind of supervisor, and nothing else: under a pane host
	// a child gets a pane, and in a plain terminal it runs as a headless process.
	activatePaneHost();

	const { config, warnings: configWarnings } = loadConfig(process.cwd(), getAgentDir());
	const parameters = buildParameters(config);
	// Roles are advertised at registration time, when there is no session context
	// yet — the process cwd is the best available answer.
	const advertisedAgents = discoverAgents(process.cwd()).agents;

	/** Watchers still running, so a shutdown can end them. */
	const watchers = new Set<AbortController>();

	/** Asked once per session — a second prompt would only nag. */
	const fixOffered: PluginFixGuard = { value: false };

	/** Cached capability probe for this registration. */
	const capability = supervisor.createCapability();

	/**
	 * The sub panes this registration opened, tracked for the layout planner. One
	 * instance per registration: the spawn recipe reads it to decide birth-vs-
	 * append and prunes it against the tab, and the completion close drops from it.
	 */
	const columns = new LiveSubPanes();

	/**
	 * Warning keys this session has already reported. One set per registration is
	 * the session scope, which is what keeps the registry-dependent floor
	 * warnings from repeating on every acknowledgment; it is threaded through
	 * `ToolDeps` to every `SpawnContext` this registration builds. Role-level
	 * warnings are exempt by design and never consult it.
	 */
	const reportedWarnings = new Set<string>();

	const pluginFix = (ctx: ExtensionContext) => offerPluginFix(ctx, { capability, fixOffered });

	registerLifecycle(pi, {
		configWarnings,
		offerPluginFix: pluginFix,
		watchers,
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
			reportedWarnings,
			// The pinned devDependency (pi-coding-agent@0.85.1) lags the runtime pi,
			// whose registry has `findOfType`/`classify`; one cast at the seam.
			route: (ctx) =>
				createRouteFn(config, { registry: ctx.modelRegistry as unknown as ClassifierRegistry }),
		}),
	);
}
