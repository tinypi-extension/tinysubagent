#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { stopHookDecision } from "./agy-stop-hook.ts";

const [reportFile, contextDir] = process.argv.slice(2);
try {
	const payload = JSON.parse(readFileSync(0, "utf8")) as unknown;
	const decision = stopHookDecision(
		typeof payload === "object" && payload !== null ? payload : {},
		reportFile ?? "",
		contextDir,
	);
	process.stdout.write(`${JSON.stringify(decision)}\n`);
} catch {
	// Fail open so malformed hook input cannot block an agy session indefinitely.
	process.stdout.write("{}\n");
}
