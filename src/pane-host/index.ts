/**
 * The supervision seam.
 *
 * Everything this extension does to a live child goes through the neutral
 * operations on {@link Supervisor}: open it, learn when its wait is over, stop
 * it, close it — and the detection and readiness that decide whether this pi
 * process may spawn at all. A child is supervised either by a pane host, or, in
 * a terminal no pane host owns, as its own detached process.
 *
 * A pane host keeps the pane-only operations — layout read, resize, rename,
 * focus, relay-an-interrupt-by-typing-Esc — and stays reachable only through
 * its kind ({@link paneHostOf}), so the seam itself never promises a layout a
 * child may not have. {@link PaneHost} is wrapped for that conformance, not
 * rewritten: its operations and their behaviour are untouched.
 *
 * The kind is chosen here, so callers never read a host's environment variables
 * or speak its CLI. A child is addressed by the handle its supervisor handed
 * back at open, so a stop or close cannot land on whichever host the
 * environment happens to name at that moment.
 */

import type { LaunchMode } from "../children/harness/index.ts";
import { createHerdrPaneHost } from "./herdr.ts";
import { createPlainSupervisor, type PlainSupervisorDeps } from "./plain.ts";
import { createRexPaneHost } from "./rex.ts";
import type {
	CapabilityCheck,
	OpenRequest,
	PaneHost,
	PaneHostKind,
	PaneHostSupervisor,
	Supervisor,
	SupervisorHandle,
} from "./types.ts";

export { LiveSubPanes, planPlacement, planResizes } from "./layout.ts";
export type { Placement } from "./layout.ts";
export { createPlainSupervisor } from "./plain.ts";
export type { PlainSupervisor, PlainSupervisorDeps, SpawnChild } from "./plain.ts";

export type {
	CapabilityCheck,
	HostFix,
	OpenChildRequest,
	OpenRequest,
	PaneHost,
	PaneHostKind,
	PaneHostSupervisor,
	PaneLayout,
	PanePlacement,
	ProbeOptions,
	Readiness,
	Rect,
	ResizeOp,
	Supervisor,
	SupervisorHandle,
	SupervisorKind,
} from "./types.ts";

const herdr = createHerdrPaneHost();
const rex = createRexPaneHost();

/** Host selection lives here, never at a call site. Herdr wins a mixed env. */
function select(env: NodeJS.ProcessEnv): PaneHost {
	if (herdr.detectedIn(env)) return herdr;
	// A partial Rex context still selects the adapter for direct seam consumers,
	// so its probe can explain what is missing. The extension itself registers
	// only after `detectPaneHost()` sees both the block and the session.
	if (rex.detectedIn(env) || env.REX_SESSION || env.REX_BLOCK) return createRexPaneHost(env);
	// With no host detected, keep herdr as the default adapter. Callers still
	// refuse to register the tool; this only preserves the seam's old shape.
	return herdr;
}

/** A seam whose adapter is resolved from `env` for every operation. */
function routed(env: () => NodeJS.ProcessEnv): PaneHost {
	const host = (): PaneHost => select(env());
	return {
		get kind() {
			return host().kind;
		},
		detectedIn(candidate) {
			return herdr.detectedIn(candidate) || rex.detectedIn(candidate);
		},
		currentPaneId: (candidate) => host().currentPaneId(candidate),
		createCapability: () => host().createCapability(),
		openChild: (request) => host().openChild(request),
		renameChild: (paneId, label) => host().renameChild(paneId, label),
		closeChild: (paneId) => host().closeChild(paneId),
		childExists: (paneId) => host().childExists(paneId),
		readLayout: (paneId) => host().readLayout(paneId),
		resizeChild: (op) => host().resizeChild(op),
		relayInterrupt: (paneIds) => host().relayInterrupt(paneIds),
	};
}

/**
 * Wrap one pane host as a supervisor: the neutral operations, and nothing else
 * on the seam. The adapter keeps its own operations unchanged behind `panes`.
 */
function paneSupervisorOf(panes: PaneHost): PaneHostSupervisor {
	const supervisor: PaneHostSupervisor = {
		// Read through to the adapter: a routed pane host's kind follows its env.
		get kind() {
			return panes.kind;
		},
		panes,
		detectedIn: (env) => panes.detectedIn(env),
		createCapability: () => panes.createCapability(),
		open: async (request: OpenRequest) => ({
			supervisor,
			id: await panes.openChild({
				cwd: request.cwd,
				scriptPath: request.scriptPath,
				label: request.label,
				targetPaneId: request.pane?.targetPaneId ?? null,
				direction: request.pane?.direction ?? "right",
				focus: request.pane?.focus ?? false,
			}),
		}),
		// A pane that is gone is the child being over; an unknown answer stays
		// unknown, because guessing an ending would end a live wait.
		ended: async (child) => {
			const alive = await panes.childExists(child.id);
			return alive === null ? null : !alive;
		},
		stop: async (child) => {
			await panes.relayInterrupt([child.id]);
		},
		close: (child) => panes.closeChild(child.id),
	};
	return supervisor;
}

/** Build a seam bound to one environment. */
export function createPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	return routed(() => env);
}

/** Build a supervisor whose kind is resolved from one environment. */
export function createSupervisor(
	env: NodeJS.ProcessEnv = process.env,
	deps: PlainSupervisorDeps = {},
): Supervisor {
	return detectPaneHost(env) === null ? createPlainSupervisor(deps) : paneSupervisorOf(routed(() => env));
}

/**
 * The environment whose host owns this extension registration. It starts null so
 * direct seam consumers keep the herdr passthrough until the extension says
 * otherwise, even when the surrounding shell happens to be a Rex block.
 */
let activeEnv: NodeJS.ProcessEnv | null = null;

/** Choose the kind for one extension registration. */
export function activatePaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost {
	activeEnv = env;
	return select(env);
}

/** The pane-only operations, used by the adapter selection below. */
export const paneHost: PaneHost = routed(() => activeEnv ?? {});

/** The pane-host kind as a supervisor, kept whole so handles keep meaning. */
const paneSupervisor: Supervisor = paneSupervisorOf(paneHost);

/** The kind a terminal with no pane host gets: one, for the whole registration. */
const plainSupervisor: Supervisor = createPlainSupervisor();

/**
 * The supervisor this registration's spawn, watch and interrupt call sites use:
 * the pane host when one is detected, the plain kind otherwise. Selection lives
 * here, so no call site decides what kind of terminal it is running in.
 */
function activeSupervisor(): Supervisor {
	if (activeEnv === null) return paneSupervisor;
	return detectPaneHost(activeEnv) === null ? plainSupervisor : paneSupervisor;
}

/**
 * The seam used by the extension's spawn, watch and interrupt call sites. Its
 * kind resolves from the registration's environment, so activation reaches the
 * supervisor too.
 *
 * It delegates instead of choosing once at import: `activatePaneHost` runs after
 * this module loads. It holds no `panes` of its own, because its kind is not
 * known until activation.
 */
export const supervisor: Supervisor = {
	get kind() {
		return activeSupervisor().kind;
	},
	detectedIn: (env) => activeSupervisor().detectedIn(env),
	createCapability: () => activeSupervisor().createCapability(),
	open: (request) => activeSupervisor().open(request),
	ended: (child) => activeSupervisor().ended(child),
	stop: (child) => activeSupervisor().stop(child),
	close: (child) => activeSupervisor().close(child),
};

/**
 * The pane-only operations of a supervisor, when its kind is a pane host; null
 * for any other kind. This is the only door to layout, resize, rename and Esc.
 */
export function paneHostOf(candidate: Supervisor): PaneHost | null {
	if (candidate.kind === "plain") return null;
	// A pane-host supervisor carries its own adapter. The registration's routing
	// seam carries none, so it gets the adapter the active environment names.
	return "panes" in candidate ? (candidate as PaneHostSupervisor).panes : paneHost;
}

/**
 * How children are supervised under this candidate's kind, in the vocabulary the
 * rest of the extension speaks: a pane host renders a child in a pane, any other
 * kind runs it as a headless process. This is the one place the two vocabularies
 * meet, so a consumer of the mode never has to know what a kind is called.
 */
export function launchModeOf(candidate: Supervisor): LaunchMode {
	return paneHostOf(candidate) === null ? "headless" : "pane";
}

/**
 * A child addressed by its pane id alone: the column tracker only ever holds
 * pane ids, and a caller that holds no spawn handle (a test fixture, an earlier
 * call's still-open pane) still addresses a pane child.
 */
export function paneChild(paneId: string): SupervisorHandle {
	return { supervisor, id: paneId };
}

/** Which host, if any, owns this pi process. */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHostKind | null {
	return herdr.detectedIn(env) || rex.detectedIn(env) ? select(env).kind : null;
}
