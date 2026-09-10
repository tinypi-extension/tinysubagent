/**
 * Launch planning: where a subagent's files live, what its shell wrapper does,
 * and the exact argv its pi process is started with.
 *
 * The child is not launched directly by herdr. herdr opens a *plugin pane* whose
 * fixed command runs the plugin dispatcher, which `exec bash`es the wrapper
 * script whose path we pass through an environment variable. So the launch
 * script is the real program here, and everything the child needs — its session
 * file, its sidecar paths, its cwd, its model — is baked into it.
 *
 * All files land under the orchestrator's own session directory:
 *
 *   <sessionDir>/artifacts/<sessionId>/subagent-scripts/<name>-<id>.sh
 *   <sessionDir>/artifacts/<sessionId>/context/<name>-<ts>.md
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { REPORT_TOOL_NAME } from "./types.ts";

/** Single-quote a string for bash. The only quoting form used in generated scripts. */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Short run id, stamped into the exit-code sidecar so a stale run cannot be mistaken for ours. */
export function runId(): string {
	return randomBytes(4).toString("hex");
}

/** Filesystem-safe, human-readable fragment for artifact names. */
export function safeName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
	return cleaned || "subagent";
}

/** Second-resolution stamp for artifact filenames. */
export function timestampForArtifacts(date: Date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Millisecond stamp for the child's session filename, matching the shape pi
 * itself uses (`2026-09-10T07-11-02-093Z`).
 */
export function timestampForSession(date: Date = new Date()): string {
	return `${date.toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
}

/**
 * Where pi keeps sessions for a given cwd: `--<cwd with separators dashed>--`
 * under the agent dir. Created eagerly, because the child writes its session
 * file there before we ever read it.
 */
export function childSessionDirFor(agentDir: string, cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = path.join(agentDir, "sessions", safePath);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export interface LaunchPaths {
	artifactDir: string;
	scriptsDir: string;
	contextDir: string;
	/** Task markdown, handed to the child as `@<taskFile>`. */
	taskFile: string;
	/** The generated shell wrapper the plugin dispatcher runs. */
	scriptFile: string;
	childSessionDir: string;
	/** The child's session jsonl — the source of its final summary. */
	childSessionFile: string;
	/** `<sessionFile>.exitcode`, written by the wrapper: `"<code> <runId>"`. */
	exitCodeFile: string;
	/** `<sessionFile>.done`, written by the child when its turn completes. */
	reportFile: string;
}

export interface LaunchPathsInput {
	/** Directory holding the orchestrator's session file. */
	sessionDir: string;
	/** Orchestrator session id, namespacing this run's artifacts. */
	sessionId: string;
	/** Agent dir the child will use (may be a project-local `.pi/agent`). */
	agentDir: string;
	cwd: string;
	name: string;
	id: string;
}

export function buildLaunchPaths(input: LaunchPathsInput): LaunchPaths {
	const artifactDir = path.join(input.sessionDir, "artifacts", input.sessionId);
	const scriptsDir = path.join(artifactDir, "subagent-scripts");
	const contextDir = path.join(artifactDir, "context");
	const fileSafe = safeName(input.name);
	const childSessionDir = childSessionDirFor(input.agentDir, input.cwd);
	const childSessionFile = path.join(
		childSessionDir,
		`${timestampForSession()}_${randomUUID()}.jsonl`,
	);

	return {
		artifactDir,
		scriptsDir,
		contextDir,
		taskFile: path.join(contextDir, `${fileSafe}-${timestampForArtifacts()}.md`),
		scriptFile: path.join(scriptsDir, `${fileSafe}-${input.id}.sh`),
		childSessionDir,
		childSessionFile,
		exitCodeFile: `${childSessionFile}.exitcode`,
		reportFile: `${childSessionFile}.done`,
	};
}

export interface LaunchFile {
	path: string;
	content: string;
}

/** Write every planned file, creating parents. Plain 0644 — bash is invoked explicitly. */
export function writeLaunchFiles(files: LaunchFile[]): void {
	for (const file of files) {
		mkdirSync(path.dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content, "utf8");
	}
}

/**
 * Task markdown: role identity, then the instruction, then the task, then the
 * output contract. Injecting the role body here (rather than as a system prompt)
 * is what the reference does for roles that do not opt into system-prompt
 * replacement — and none of the installed roles do.
 *
 * The output contract names the report tool explicitly. It is the last thing the
 * child reads, and a model that never learns the tool name never calls it — its
 * result is then only ever a scrape of the session. The fallback is still stated
 * so a child that skips the call is not left without a way to finish.
 */
export function buildTaskMarkdown(opts: {
	body?: string | null;
	task: string;
}): string {
	const roleBlock = opts.body && opts.body.trim() !== "" ? `${opts.body.trim()}\n\n` : "";
	return (
		`${roleBlock}Complete your task autonomously.\n\n` +
		`${opts.task.trim()}\n\n` +
		`When your task is complete, call \`${REPORT_TOOL_NAME}\` with your full result in the ` +
		"`result` argument. That call is what the caller receives and what closes this pane — " +
		"do not skip it. Write your final assistant message as that same self-contained summary; " +
		"if the report does not arrive, the caller reads it instead."
	);
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
