/**
 * The Rex CLI, as this extension uses it.
 *
 * Every call is a subprocess of `rex`. The block and session come from the
 * environment of the orchestrator block; an optional server pins commands that
 * could otherwise follow the app's current focus. No plugin is involved and no
 * version is required: if the CLI answers, Rex can open blocks.
 */

import { execFile } from "node:child_process";

export interface RexContext {
	session: string | null;
	block: string | null;
	server: string | null;
}

/** True when this pi process is running inside a Rex block. */
export function isInsideRex(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.REX_BLOCK) && Boolean(env.REX_SESSION);
}

/** The pane-host context captured from this process. */
export function rexContext(env: NodeJS.ProcessEnv = process.env): RexContext {
	return {
		session: env.REX_SESSION || null,
		block: env.REX_BLOCK || null,
		server: env.REX_SERVER || null,
	};
}

/** Session/server pinning shared by every block-scoped command. */
export function scopeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const { session, server } = rexContext(env);
	const args: string[] = [];
	if (session) args.push("-s", session);
	if (server) args.push("-S", server);
	return args;
}

export interface RunOptions {
	timeoutMs?: number;
}

interface RexResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runRexRaw(args: string[], options: RunOptions = {}): Promise<RexResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"rex",
			args,
			{ timeout: options.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = (error as { code?: unknown } | null)?.code;
				if (error && typeof code !== "number") {
					reject(error);
					return;
				}
				resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
			},
		);
	});
}

/** Run a Rex command that has to work, throwing with its own message. */
export async function runRex(args: string[], options: RunOptions = {}): Promise<string> {
	const result = await runRexRaw(args, options);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new Error(`rex ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

/** Cosmetic commands never fail their caller. */
export async function runRexQuiet(args: string[], options: RunOptions = {}): Promise<boolean> {
	try {
		await runRex(args, options);
		return true;
	} catch {
		return false;
	}
}

/** Flatten a possible `{id, result}` envelope; bare objects pass through. */
function unwrap(value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (record.result && typeof record.result === "object") return record.result;
	}
	return value;
}

/** Parse a Rex JSON body, whether or not it is wrapped in a CLI envelope. */
export function parseRexJson(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const value = unwrap(parsed);
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Run a Rex command expected to return a JSON object. */
export async function runRexJson(args: string[], options: RunOptions = {}): Promise<Record<string, unknown>> {
	const parsed = parseRexJson(await runRex(args, options));
	if (!parsed) throw new Error(`rex ${args.join(" ")} did not return JSON.`);
	return parsed;
}

/** A reachable CLI is all the readiness Rex needs today. */
export async function rexReachable(options: RunOptions = {}): Promise<boolean> {
	try {
		// `version` is the portable subcommand; current Rex rejects `--version`.
		const output = await runRex(["version"], options);
		return output.trim().length > 0;
	} catch {
		return false;
	}
}
