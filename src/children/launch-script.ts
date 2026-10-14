/**
 * Launch scripting: the shell wrapper a subagent pane runs and the exact argv
 * its pi process is started with.
 *
 * The child is not launched directly by herdr. herdr opens a *plugin pane* whose
 * fixed command runs the plugin dispatcher, which `exec bash`es the wrapper
 * script whose path we pass through an environment variable. So the launch
 * script is the real program here — but it computes nothing: every path it needs
 * (its own sidecars, its cwd, its session) arrives as a literal option string.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import { piHarness } from "./harness/index.ts";

/** Single-quote a string for bash. The only quoting form used in generated scripts. */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface LaunchScriptOptions {
	name: string;
	agent: string | null;
	id: string;
	cwd: string;
	piArgv: string[];
	envPath: string;
	agentDir: string | null;
	childSessionFile: string;
	reportFile: string;
	/** `<sessionFile>.exitcode`, stamped by the wrapper on the way out. */
	exitCodeFile: string;
	/** Command prefix, e.g. `direnv exec '<cwd>'`, or "" . */
	launchPrefix?: string;
	/** Close the pane even on a crash instead of holding it open for inspection. */
	holdOpenSecs?: number;
	/** Plain NAME → value pairs from the settings file, exported before launch-owned vars. */
	env?: Record<string, string>;
	harness?: "pi" | "agy";
}

export const DEFAULT_HOLD_OPEN_SECS = 15;

/**
 * The generated wrapper. Its contract with the orchestrator is small and total:
 *
 *   - run pi in the child session,
 *   - always stamp `<sessionFile>.exitcode` with `"<code> <runId>"`,
 *   - exit with pi's code, so the pane closes itself.
 *
 * A non-zero exit shortly after start is almost always a launch problem (bad
 * model, bad flag), so the pane is held open briefly to let a human read it.
 */
export function buildLaunchScript(opts: LaunchScriptOptions): string {
	const piCommand =
		(opts.launchPrefix ? `${opts.launchPrefix} ` : "") +
		opts.piArgv.map((arg) => shellEscape(arg)).join(" ");

	const lines: string[] = [
		"#!/usr/bin/env bash",
		"# tinysubagent launch script — generated, do not edit.",
		`# subagent: ${opts.name}`,
		`# agent: ${opts.agent ?? "(none)"}`,
		`# run id: ${opts.id}`,
		`# generated: ${new Date().toISOString()}`,
		"# Ignore SIGTSTP: an argv-launched pane has no interactive parent shell to",
		"# resume from, so Ctrl+Z would wedge the pane permanently.",
		"trap '' TSTP",
	];

	// Config-owned variables come before every launch-owned export, so the wrapper's
	// own PATH and PI_* values win on a collision without a blocklist to maintain.
	if (opts.env && Object.keys(opts.env).length > 0) {
		lines.push("# tinysubagent: env from config");
		for (const [key, value] of Object.entries(opts.env)) {
			lines.push(`export ${key}=${shellEscape(value)}`);
		}
	}

	lines.push(`export PATH=${shellEscape(opts.envPath)}`);

	if (opts.agentDir) {
		lines.push(`export PI_CODING_AGENT_DIR=${shellEscape(opts.agentDir)}`);
	}

	lines.push(
		`export PI_TINYSUBAGENT_NAME=${shellEscape(opts.name)}`,
		`export PI_TINYSUBAGENT_ID=${shellEscape(opts.id)}`,
		`export PI_TINYSUBAGENT_SESSION=${shellEscape(opts.childSessionFile)}`,
		`export PI_TINYSUBAGENT_REPORT=${shellEscape(opts.reportFile)}`,
		// The pane id only exists inside the pane — forward what herdr injected.
		'export PI_TINYSUBAGENT_PANE="${HERDR_PANE_ID:-}"',
	);

	if (opts.agent) {
		lines.push(`export PI_TINYSUBAGENT_AGENT=${shellEscape(opts.agent)}`);
	}

	// Agy runs from the project cwd and uses its existing project hooks. We never
	// inject a Stop hook; report sidecars drive orchestrator completion.
	lines.push(`cd ${shellEscape(opts.cwd)}`);

	lines.push(
		piCommand,
		"code=$?",
	);
	if (opts.harness === "agy") {
		lines.push(
			`if [ "$code" -eq 0 ] && [ ! -f ${shellEscape(opts.reportFile)} ]; then printf '%s\\n' '{"type":"failed","reason":"no-output"}' > ${shellEscape(`${opts.reportFile}.tmp`)} && mv ${shellEscape(`${opts.reportFile}.tmp`)} ${shellEscape(opts.reportFile)}; fi`,
		);
	}
	lines.push(`echo "$code $PI_TINYSUBAGENT_ID" > ${shellEscape(opts.exitCodeFile)}`);

	const holdOpenSecs = opts.holdOpenSecs ?? DEFAULT_HOLD_OPEN_SECS;
	if (holdOpenSecs > 0) {
		lines.push(
			`if [ "$code" -ne 0 ] && [ "$SECONDS" -lt ${holdOpenSecs} ]; then`,
			'  echo "tinysubagent: subagent exited $code — press Enter to close"',
			"  read -r",
			"fi",
		);
	}

	lines.push('exit "$code"', "");
	return lines.join("\n");
}

export interface PiArgvOptions {
	piBin: string;
	childSessionFile: string;
	childExtensionPath: string;
	/** Session display name, passed through verbatim as `--name`. */
	name?: string | null;
	model?: string | null;
	thinking?: string | null;
	tools?: string[] | null;
	taskFile: string;
}

/**
 * Child argv, as the pi harness builds it. Kept as a named export because both
 * spawn.ts and the launch tests predate the harness split; the body lives in
 * `harness/pi.ts` now.
 */
export function buildPiArgv(opts: PiArgvOptions): string[] {
	return piHarness.buildArgv({ ...opts, bin: opts.piBin });
}

/** Bin override from the env, resolved by the pi harness. */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
	return piHarness.resolveBin(env);
}

/**
 * Prepended to the pi command. A project's `.envrc` normally takes effect when an
 * interactive shell starts; a dispatcher-run pane never starts one, so the
 * wrapper would otherwise see a bare PATH. `PI_HERDR_DIRENV=0` opts out, and
 * `PI_HERDR_LAUNCH_PREFIX` replaces the whole mechanism (`{cwd}` is substituted).
 */
export function resolveLaunchPrefix(env: NodeJS.ProcessEnv, cwd: string): string {
	const template = env.PI_HERDR_LAUNCH_PREFIX;
	if (template != null) return template.replaceAll("{cwd}", shellEscape(cwd)).trim();
	if (env.PI_HERDR_DIRENV === "0") return "";
	if (existsSync(path.join(cwd, ".envrc"))) return `direnv exec ${shellEscape(cwd)}`;
	return "";
}
