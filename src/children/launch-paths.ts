/**
 * Launch path planning: where a subagent's files live.
 *
 * All files land under the orchestrator's own session directory:
 *
 *   <sessionDir>/artifacts/<sessionId>/subagent-scripts/<name>-<id>.sh
 *   <sessionDir>/artifacts/<sessionId>/context/<name>-<ts>.md
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

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
