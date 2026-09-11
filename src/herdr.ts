/**
 * The herdr CLI, as this extension uses it.
 *
 * Two panes and a socket are all that matter here:
 *
 *   - panes are created, named and reaped through `herdr plugin pane open`,
 *     `herdr pane rename` and `herdr pane close`;
 *   - the `tinysubagent-panes` plugin — shipped in `herdr-plugin/` beside this
 *     module — supplies the *entrypoint*: a dispatcher that reads the
 *     launch-script path out of an environment variable and `exec bash`es it.
 *     We never type into a pane's shell, so there is no race with the pane's
 *     own startup (direnv, rc files, prompt).
 *
 * Every call is a subprocess. herdr prints an envelope —
 * `{"id":"cli:...","result":{...}}` — for most commands but a bare object for
 * `status server`, so {@link unwrap} flattens both.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin id of the linked herdr plugin whose dispatcher starts our wrapper. */
export const PLUGIN_ID = "tinysubagent-panes";
/** Pane entrypoint inside that plugin (see its `herdr-plugin.toml`). */
export const PLUGIN_ENTRYPOINT = "subagent";
/** Split plugin panes exist from 0.8.2; the shipped manifest declares the same. */
export const MIN_HERDR_VERSION = "0.8.2";

/**
 * The plugin directory this package ships. Resolved from this module's own
 * location so the link instruction names a real path whatever the install
 * method (local checkout, directory install, git clone).
 */
export function pluginDir(): string {
	return join(dirname(dirname(fileURLToPath(import.meta.url))), "herdr-plugin");
}

export interface HerdrStatus {
	running: boolean;
	version: string | null;
}

export interface HerdrPluginInfo {
	id: string;
	enabled: boolean;
}

/**
 * True when this pi process is itself running inside a herdr pane. This is the
 * gate for registering the tool at all: outside herdr there is nothing to spawn
 * panes into, and the reference implementation's fallback (blocking subprocess)
 * is deliberately not part of tinysubagent.
 */
export function isInsideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID) && Boolean(env.HERDR_SOCKET_PATH);
}

/** The pane this pi is running in, used as the split target. */
export function currentPaneId(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.HERDR_PANE_ID || null;
}

function herdrBin(env: NodeJS.ProcessEnv = process.env): string {
	return env.HERDR_BIN_PATH || "herdr";
}

export interface RunOptions {
	timeoutMs?: number;
}

interface HerdrRawResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run herdr and report what it said, whatever its exit status. Needed because
 * herdr reports some failures in the *body* on stderr with a non-zero status
 * (`pane get` on a missing pane), so neither the status nor stdout alone tells
 * the whole story.
 */
function runHerdrRaw(args: string[], options: RunOptions = {}): Promise<HerdrRawResult> {
	return new Promise((resolve, reject) => {
		execFile(
			herdrBin(),
			args,
			{ timeout: options.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// A numeric `code` is an exit status we can interpret; anything else
				// (ENOENT, a timeout kill) means herdr never answered.
				const exitCode = (error as { code?: unknown } | null)?.code;
				if (error && typeof exitCode !== "number") {
					reject(error);
					return;
				}
				resolve({ code: typeof exitCode === "number" ? exitCode : 0, stdout, stderr });
			},
		);
	});
}

async function runHerdr(args: string[], options: RunOptions = {}): Promise<string> {
	const result = await runHerdrRaw(args, options);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new Error(`herdr ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

/** Flatten herdr's `{id, result}` envelope; bare objects pass through. */
function unwrap(value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (typeof record.id === "string" && record.result && typeof record.result === "object") {
			return record.result;
		}
	}
	return value;
}

/** Parse one of herdr's JSON bodies, unwrapping the envelope. */
function parseHerdrJson(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const unwrapped = unwrap(parsed);
	return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
		? (unwrapped as Record<string, unknown>)
		: null;
}

async function runHerdrJson(args: string[], options: RunOptions = {}): Promise<Record<string, unknown>> {
	const stdout = await runHerdr(args, options);
	const parsed = parseHerdrJson(stdout);
	if (!parsed) throw new Error(`herdr ${args.join(" ")} did not return JSON.`);
	return parsed;
}

/** Best-effort variant for cosmetic calls (rename, close) that must never fail a spawn. */
async function runHerdrQuiet(args: string[], options: RunOptions = {}): Promise<boolean> {
	try {
		await runHerdr(args, options);
		return true;
	} catch {
		return false;
	}
}

/**
 * Compare dotted versions. Anything unparseable is "not at least", so an
 * unexpected herdr version string is treated as unsupported rather than
 * assumed good.
 */
export function versionAtLeast(actual: string, minimum: string): boolean {
	const parse = (value: string): number[] | null => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		return match ? match.slice(1).map(Number) : null;
	};
	const actualParts = parse(actual);
	const minimumParts = parse(minimum);
	if (!actualParts || !minimumParts) return false;
	for (let i = 0; i < 3; i += 1) {
		const a = actualParts[i] ?? 0;
		const b = minimumParts[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

export async function herdrStatus(options: RunOptions = {}): Promise<HerdrStatus | null> {
	try {
		const result = await runHerdrJson(["status", "server", "--json"], options);
		const version = typeof result.version === "string" ? result.version : null;
		return { running: result.running === true || result.status === "running", version };
	} catch {
		return null;
	}
}

export async function herdrPluginInfo(
	id: string = PLUGIN_ID,
	options: RunOptions = {},
): Promise<HerdrPluginInfo | null> {
	try {
		const result = await runHerdrJson(["plugin", "list", "--json"], options);
		const plugins = Array.isArray(result.plugins) ? (result.plugins as Record<string, unknown>[]) : [];
		const found = plugins.find((entry) => entry.plugin_id === id || entry.id === id);
		if (!found) return null;
		return { id, enabled: found.enabled !== false };
	} catch {
		return null;
	}
}

/**
 * Register a local plugin directory and enable it in the same step.
 *
 * Idempotent: herdr accepts a re-link of the path it already has and keeps it
 * enabled, so a repeat is a no-op rather than an error. That is what lets the
 * session hook offer the fix without first proving the plugin is absent — and
 * what makes a stale link repairable by offering the same one-keypress fix.
 */
export async function herdrPluginLink(path: string, options: RunOptions = {}): Promise<void> {
	await runHerdr(["plugin", "link", path, "--enabled"], options);
}

/** Enable a plugin that is linked but switched off. */
export async function herdrPluginEnable(id: string = PLUGIN_ID, options: RunOptions = {}): Promise<void> {
	await runHerdr(["plugin", "enable", id], options);
}

export interface PaneOpenOptions {
	/** Working directory herdr gives the new pane (the wrapper also `cd`s). */
	cwd: string;
	/** Pane to split; defaults to the pane this pi runs in. */
	targetPaneId?: string | null;
	direction?: "right" | "down";
	/** Extra environment for the pane process — carries the launch-script path. */
	env?: Record<string, string>;
	focus?: boolean;
}

/**
 * Open a plugin pane and return its id. Throws when herdr does not report an
 * id: a pane we cannot address is a pane we cannot rename, reap or reason about.
 */
export async function herdrPaneOpen(options: PaneOpenOptions): Promise<string> {
	const args = [
		"plugin",
		"pane",
		"open",
		"--plugin",
		PLUGIN_ID,
		"--entrypoint",
		PLUGIN_ENTRYPOINT,
		"--placement",
		"split",
	];
	if (options.targetPaneId) args.push("--target-pane", options.targetPaneId);
	args.push("--direction", options.direction ?? "right");
	args.push("--cwd", options.cwd);
	for (const [key, value] of Object.entries(options.env ?? {})) {
		args.push("--env", `${key}=${value}`);
	}
	args.push(options.focus ? "--focus" : "--no-focus");

	const result = await runHerdrJson(args, { timeoutMs: 30_000 });
	const pane = result.plugin_pane as Record<string, unknown> | undefined;
	const nested = pane?.pane as Record<string, unknown> | undefined;
	const paneId = nested?.pane_id ?? pane?.pane_id ?? result.pane_id;
	if (typeof paneId !== "string" || paneId === "") {
		throw new Error(`herdr opened a pane but reported no id (${JSON.stringify(result)}).`);
	}
	return paneId;
}

/** Cosmetic; failures are ignored by callers. */
export async function herdrPaneRename(paneId: string, label: string): Promise<boolean> {
	return runHerdrQuiet(["pane", "rename", paneId, label]);
}

/**
 * Reap a pane.
 *
 * A pane whose command has exited closes by itself, so a `false` result is the
 * normal case rather than a failure: `herdr pane close` reports "pane_not_found"
 * once the pane is already gone. This exists for the times a pane outlives its
 * child — notably the wrapper's hold-open window after an early crash.
 */
export async function herdrPaneClose(paneId: string): Promise<boolean> {
	return runHerdrQuiet(["pane", "close", paneId], { timeoutMs: 10_000 });
}

/**
 * Is this pane still open?
 *
 * `herdr pane get` is the probe: on a missing pane it writes
 * `{"error":{"code":"pane_not_found"}}` to stderr and exits 1, so the answer
 * has to be read from the body rather than the status. Anything we cannot
 * interpret — a timeout, a herdr that is briefly unreachable — returns null, so
 * callers can tell "gone" apart from "unknown" instead of treating a failed
 * probe as a death.
 */
export async function herdrPaneExists(paneId: string, options: RunOptions = {}): Promise<boolean | null> {
	let result: HerdrRawResult;
	try {
		result = await runHerdrRaw(["pane", "get", paneId], options);
	} catch {
		return null;
	}

	const body = parseHerdrJson(result.stdout) ?? parseHerdrJson(result.stderr);
	if (!body) return null;

	if (body.error && typeof body.error === "object") {
		const code = (body.error as Record<string, unknown>).code;
		return code === "pane_not_found" ? false : null;
	}
	const pane = body.pane as Record<string, unknown> | undefined;
	if (pane && typeof pane.pane_id === "string") return true;
	return null;
}
