/**
 * The harness contract: what the orchestrator needs from any child CLI.
 *
 * A harness is one child program (pi, agy) behind one interface. Everything
 * harness-specific — which binary to run, which argv launches a task, whether
 * the child takes pi's `-e` extension, where its transcript lives, how its last
 * turn is scraped — is a member here, so the spawn recipe and the launch script
 * stay CLI-agnostic.
 */

import type { PreflightContext } from "../preflight.ts";

/** Which CLI a child runs on. */
export type HarnessId = "pi" | "agy";

/** Everything {@link ChildHarness.buildArgv} needs. No env access: the caller resolves the bin. */
export interface HarnessArgvSpec {
	/** The resolved binary, argv[0]. */
	bin: string;
	childSessionFile: string;
	childExtensionPath: string;
	/** Session display name, passed through verbatim as `--name`. */
	name?: string | null;
	model?: string | null;
	thinking?: string | null;
	tools?: string[] | null;
	/** The task is delivered as a file reference so the prompt never appears in `ps`. */
	taskFile: string;
}

/** What scraping the child's transcript for its last turn yields. */
export interface TurnInfo {
	/** The last assistant text, or null when the transcript holds none. */
	text: string | null;
}

export interface ChildHarness {
	id: HarnessId;
	/** Bin override from the environment, else the CLI's default name on PATH. */
	resolveBin(env: NodeJS.ProcessEnv): string;
	/** Full argv. The prompt is delivered as a file reference, never inline. */
	buildArgv(spec: HarnessArgvSpec): string[];
	/** Whether the child takes pi's `-e <extension>` hook. */
	supportsExtension: boolean;
	/**
	 * Where this harness keeps its per-run transcript. pi: the child session
	 * jsonl the sidecars are named after. agy: not knowable up front (the
	 * transcript path arrives with the Stop hook payload).
	 */
	sessionFileFor(cwd: string, agentDir: string): string;
	/**
	 * Scrape the child's transcript for its last turn. Returns null when this
	 * harness is report-only — agy's report sidecar is authoritative and its
	 * transcript carries no usable verdict.
	 */
	readTurn(file: string): TurnInfo | null;
	/**
	 * The refusal this harness is about to raise for a run that never starts,
	 * or null when it will start. pi: the preflight check. agy: always null in
	 * v1 — startup failures surface as a non-zero exit instead.
	 */
	readRefusal(ctx: PreflightContext): Promise<string | null>;
}
