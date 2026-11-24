/** The TUI kinds this extension can host sub panes in. */
export type PaneHostKind = "herdr" | "rex";

/** A pane's rect, in whatever units the host reports them. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Geometry the host reported for one window. */
export interface PaneLayout {
	windowId: string | null;
	panes: { paneId: string; rect: Rect }[];
	/** Smallest meaningful movement in this layout's units; herdr defaults to one row. */
	tolerance?: number;
}

/** One divider move, described without naming a host command. */
export interface ResizeOp {
	paneId: string;
	direction: "left" | "right" | "up" | "down";
	/** Fraction of the split node's rect. */
	amount: number;
}

/** One child spawn, described without naming a host. */
export interface OpenChildRequest {
	cwd: string;
	/** Pane to split; the adapter falls back to the orchestrator's pane. */
	targetPaneId: string | null;
	direction: "right" | "down";
	/** Path to the generated wrapper script the sub pane runs. */
	scriptPath: string;
	/** The child's short name, shown as its label where the host supports one. */
	label?: string;
	focus: boolean;
}

/** Options for one host capability probe. */
export interface ProbeOptions {
	timeoutMs?: number;
}

/**
 * A one-step repair the host can offer. The adapter owns its wording and its
 * command; callers only confirm and apply it.
 */
export interface HostFix {
	title: string;
	detail: string;
	apply(): Promise<void>;
	/** Notices shown after an applied or failed repair. */
	applied(): string;
	failed(error: unknown): string;
}

/** The probe's answer: a problem, and at most one fix. */
export interface Readiness {
	problem: string | null;
	fix: HostFix | null;
}

/** Cached readiness verdict for one extension registration. */
export interface CapabilityCheck {
	ensureReady(): Promise<string | null>;
	probe(options?: ProbeOptions): Promise<Readiness>;
	reset(): void;
}

/**
 * The pane-only operations of one host. Only the adapter knows which CLI and
 * which environment variables back them.
 */
export interface PaneHost {
	readonly kind: PaneHostKind;
	/** True when this pi process is running inside this host. */
	detectedIn(env: NodeJS.ProcessEnv): boolean;
	/** The pane the orchestrator runs in, used as the birth split target. */
	currentPaneId(env: NodeJS.ProcessEnv): string | null;
	/** Fresh readiness cache, one per extension registration. */
	createCapability(): CapabilityCheck;
	/** Open a sub pane and return its full, addressable id. */
	openChild(request: OpenChildRequest): Promise<string>;
	renameChild(paneId: string, label: string): Promise<boolean>;
	closeChild(paneId: string): Promise<boolean>;
	/** True when the child's pane still exists; null when the host cannot tell. */
	childExists(paneId: string): Promise<boolean | null>;
	readLayout(paneId: string): Promise<PaneLayout | null>;
	resizeChild(op: ResizeOp): Promise<boolean>;
	/**
	 * Send one Esc per pane and resolve once each keystroke has been sent.
	 * Herdr resolves as soon as the sends are issued; never rejects.
	 */
	relayInterrupt(paneIds: readonly string[]): Promise<void>;
}

/**
 * The kinds of supervisor this extension can choose: a pane host, or the plain
 * terminal that has none.
 */
export type SupervisorKind = PaneHostKind | "plain";

/**
 * Where a child's pane is born, when the chosen kind of supervisor is a pane
 * host. A kind with no panes has nowhere to put it and ignores this.
 */
export interface PanePlacement {
	/** Pane to split; null asks the adapter for its own anchor. */
	targetPaneId: string | null;
	direction: "right" | "down";
	focus: boolean;
}

/** One child to start, described without naming a kind. */
export interface OpenRequest {
	cwd: string;
	/** Path to the generated wrapper script the child runs. */
	scriptPath: string;
	/** The child's short name, shown as its label where the kind supports one. */
	label?: string;
	/** Pane hosts only: where the child's pane is born. */
	pane?: PanePlacement;
}

/**
 * One live child, addressed for supervision: the supervisor that opened it and
 * the address this child has there. Only that supervisor can end, stop or close
 * it, so no later call has to guess which kind of child this is.
 */
export interface SupervisorHandle {
	readonly supervisor: Supervisor;
	readonly id: string;
}

/**
 * The seam every spawn goes through: open a child, learn when its wait is over,
 * stop it, close it — and the detection and readiness that decide whether this
 * pi process may spawn at all.
 *
 * Deliberately narrower than a pane host: layout, resize, rename, focus and
 * relay-by-typing-Esc are not here, because only a pane host can honour them.
 */
export interface Supervisor {
	readonly kind: SupervisorKind;
	/** True when this pi process is running under this kind of supervisor. */
	detectedIn(env: NodeJS.ProcessEnv): boolean;
	/** Fresh readiness cache, one per extension registration. */
	createCapability(): CapabilityCheck;
	/** Open a child and return the handle that addresses it from here on. */
	open(request: OpenRequest): Promise<SupervisorHandle>;
	/** True once the child is over, false while it is alive; null when the kind cannot tell. */
	ended(child: SupervisorHandle): Promise<boolean | null>;
	/**
	 * Stop one child: the operator's interrupt. A pane host relays a keystroke into
	 * the child's pane; a kind with no pane ends the child's process group instead.
	 * Never rejects.
	 */
	stop(child: SupervisorHandle): Promise<void>;
	close(child: SupervisorHandle): Promise<boolean>;
	/**
	 * Subscribe to a child's stdout as text; returns the unsubscribe.
	 *
	 * Only a kind that reads a child's output has this: a pane child is addressed
	 * by its pane, not by a stream, so the member is absent there rather than
	 * present and inert.
	 */
	output?(child: SupervisorHandle, onText: (chunk: string) => void): () => void;
	/**
	 * The end of a child's stderr as it stands, for a failure report; empty when the
	 * child wrote nothing there. Only a kind that gives a child a stderr stream of
	 * its own has this: a pane child's crash is readable on its pane, so the member
	 * is absent there rather than present and empty.
	 */
	stderr?(child: SupervisorHandle): string;
}

/** A supervisor whose kind is a pane host: the only home of the pane-only operations. */
export interface PaneHostSupervisor extends Supervisor {
	readonly kind: PaneHostKind;
	readonly panes: PaneHost;
}
