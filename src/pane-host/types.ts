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
 * The host-neutral pane-host seam. Only the adapter knows which CLI and which
 * environment variables back these operations.
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
