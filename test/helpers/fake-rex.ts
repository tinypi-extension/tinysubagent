/**
 * A fake `rex` on PATH for pane-host tests. It records every invocation and
 * answers selected commands from fixtures; no real Rex block is ever touched.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeResponse {
	stdout?: string;
	stderr?: string;
	exit?: number;
	/** Sleep before logging the call, so a test can hold a command in flight. */
	delayMs?: number;
}

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Run with a fake `rex` that logs `$*` and matches commands by first word. */
export async function withFakeRex<T>(
	responses: Record<string, string | FakeResponse>,
	run: (calls: () => string[]) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-seam-"));
	const argvFile = join(dir, "argv");
	writeFileSync(argvFile, "");
	const cases: string[] = [];
	for (const [key, value] of Object.entries(responses)) {
		const response: FakeResponse = typeof value === "string" ? { stdout: value } : value;
		const file = join(dir, `${key.replace(/\W/g, "_")}_out`);
		const errorFile = join(dir, `${key.replace(/\W/g, "_")}_err`);
		writeFileSync(file, response.stdout ?? "");
		writeFileSync(errorFile, response.stderr ?? "");
		const emit = response.stderr
			? `cat ${shellQuote(errorFile)} 1>&2; exit ${response.exit ?? 1}`
			: `cat ${shellQuote(file)}; exit ${response.exit ?? 0}`;
		const delay = response.delayMs ? `sleep ${shellQuote(String(response.delayMs / 1000))}; ` : "";
		cases.push(`  "${key}") ${delay}${emit} ;;`);
	}
	const bin = join(dir, "rex");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${shellQuote(argvFile)}`,
			'case "$1" in',
			...cases,
			'  *) printf "unexpected rex command: %s\\n" "$*" 1>&2; exit 1 ;;',
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${savedPath ? `:${savedPath}` : ""}`;
	const calls = (): string[] => readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean);
	try {
		return await run(calls);
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	}
}

/** A PATH with a directory that contains no `rex`, so a probe cannot reach it. */
export async function withoutRex<T>(run: () => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-missing-"));
	const savedPath = process.env.PATH;
	process.env.PATH = dir;
	try {
		return await run();
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	}
}
