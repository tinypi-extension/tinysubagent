/**
 * The pi harness: today's child CLI, unchanged, expressed as a `ChildHarness`.
 *
 * Everything here is moved behaviour, not new behaviour — the argv shape, the
 * bin resolution and the session scraping are exactly what `launch-script.ts`
 * and the watcher did before the harness split. The existing suites are the
 * regression gate for that claim.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { childSessionDirFor, timestampForSession } from "../launch-paths.ts";
import { preflightRefusal, type PreflightContext } from "../preflight.ts";
import { readFinalMessage } from "../session.ts";
import type { ChildHarness, HarnessArgvSpec, TurnInfo } from "./types.ts";

/** Override, else the `pi` on PATH (the wrapper exports the parent's PATH). */
function resolvePiBin(env: NodeJS.ProcessEnv): string {
	return env.PI_HERDR_PI_BIN || "pi";
}

/**
 * Child argv. Model and thinking are two independent flags — the `model:thinking`
 * colon syntax is not used here. The task is delivered as a file reference so
 * the prompt never appears in `ps` output and never needs escaping.
 */
function buildPiArgv(spec: HarnessArgvSpec): string[] {
	const argv = [spec.bin, "--session", spec.childSessionFile, "-e", spec.childExtensionPath];
	if (spec.name) argv.push("--name", spec.name);
	if (spec.model) argv.push("--model", spec.model);
	if (spec.thinking) argv.push("--thinking", spec.thinking);
	if (spec.tools && spec.tools.length > 0) argv.push("--tools", spec.tools.join(","));
	argv.push(`@${spec.taskFile}`);
	return argv;
}

/** The child session jsonl, named the way pi names its own sessions. */
function sessionFileFor(cwd: string, agentDir: string): string {
	return path.join(
		childSessionDirFor(agentDir, cwd),
		`${timestampForSession()}_${randomUUID()}.jsonl`,
	);
}

export const piHarness: ChildHarness = {
	id: "pi",
	resolveBin: resolvePiBin,
	buildArgv: buildPiArgv,
	supportsExtension: true,
	sessionFileFor,
	readTurn(file: string): TurnInfo | null {
		return { text: readFinalMessage(file) };
	},
	readRefusal(ctx: PreflightContext): Promise<string | null> {
		return preflightRefusal(ctx);
	},
};
