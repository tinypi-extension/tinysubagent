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
		`export PATH=${shellEscape(opts.envPath)}`,
	];

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

	lines.push(
		`cd ${shellEscape(opts.cwd)}`,
		piCommand,
		"code=$?",
		`echo "$code $PI_TINYSUBAGENT_ID" > ${shellEscape(opts.exitCodeFile)}`,
	);

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
 * Child argv. Model and thinking are two independent flags — the `model:thinking`
 * colon syntax is not used here. The task is delivered as a file reference so
 * the prompt never appears in `ps` output and never needs escaping.
 */
export function buildPiArgv(opts: PiArgvOptions): string[] {
	const argv = [opts.piBin, "--session", opts.childSessionFile, "-e", opts.childExtensionPath];
	if (opts.name) argv.push("--name", opts.name);
	if (opts.model) argv.push("--model", opts.model);
	if (opts.thinking) argv.push("--thinking", opts.thinking);
	if (opts.tools && opts.tools.length > 0) argv.push("--tools", opts.tools.join(","));
	argv.push(`@${opts.taskFile}`);
	return argv;
}

/** Override, else the `pi` on PATH (the wrapper exports the parent's PATH). */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_HERDR_PI_BIN || "pi";
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
