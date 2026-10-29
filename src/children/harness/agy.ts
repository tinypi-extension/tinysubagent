/** The agy CLI adapter. Its argv contract was pinned by the S0 live spike. */

import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import type { ChildHarness, HarnessArgvSpec, TurnInfo } from "./types.ts";

function resolveAgyBin(env: NodeJS.ProcessEnv): string {
	return env.TINYSUBAGENT_AGY_BIN || "agy";
}

/** Return false only when an explicit path/PATH lookup proves the binary absent. */
export function agyBinAvailable(bin: string, env: NodeJS.ProcessEnv): boolean {
	const candidates = bin.includes(path.sep)
		? [path.isAbsolute(bin) ? bin : path.resolve(bin)]
		: (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
	return candidates.some((candidate) => {
		try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
	});
}

function effortForThinking(thinking: string | null | undefined): "low" | "medium" | "high" | undefined {
	if (thinking === "off" || thinking === "minimal" || thinking === "low") return "low";
	if (thinking === "medium") return "medium";
	if (thinking === "high" || thinking === "xhigh" || thinking === "max") return "high";
	return undefined;
}

function buildAgyArgv(spec: HarnessArgvSpec): string[] {
	const argv = [spec.bin, "--model", spec.model ?? ""];
	const effort = effortForThinking(spec.thinking);
	if (effort) argv.push("--effort", effort);
	argv.push("-i", `@${spec.taskFile}`);
	return argv;
}

export const agyHarness: ChildHarness = {
	id: "agy",
	resolveBin: resolveAgyBin,
	buildArgv: buildAgyArgv,
	supportsExtension: false,
	// The actual transcript path arrives in agy's Stop hook payload, not at spawn.
	sessionFileFor(): string {
		return "";
	},
	readTurn(_file: string): TurnInfo | null {
		return null;
	},
};
