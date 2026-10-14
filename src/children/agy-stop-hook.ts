/** Stop-hook decision logic. Kept pure enough to test without an agy process. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const AGY_REPORT_NUDGE = "Call the report now: write your final report to $PI_TINYSUBAGENT_REPORT.";

export interface AgyStopPayload {
	conversationId?: unknown;
	artifactDirectoryPath?: unknown;
}

export type AgyStopDecision =
	| { decision: "allow" }
	| { decision: "continue"; reason: string };

/** Only a sidecar matching the watcher contract counts as a report. */
export function isValidReportSidecar(file: string): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const report = value as Record<string, unknown>;
		if (report.type === "done") {
			return report.result === undefined || typeof report.result === "string";
		}
		if (report.type === "failed") {
			return typeof report.reason === "string" && (report.message === undefined || typeof report.message === "string");
		}
		return false;
	} catch {
		return false;
	}
}

/** One nudge per conversation; after that, keep the pane open without looping. */
export function stopHookDecision(
	payload: AgyStopPayload,
	reportFile: string,
	contextDir?: string,
): AgyStopDecision {
	if (isValidReportSidecar(reportFile)) return { decision: "allow" };

	const id = typeof payload.conversationId === "string" && payload.conversationId.trim() !== ""
		? payload.conversationId
		: "unknown";
	const dir = contextDir ?? (typeof payload.artifactDirectoryPath === "string"
		? path.join(payload.artifactDirectoryPath, "context")
		: null);
	if (!dir) return { decision: "allow" };
	const counterFile = path.join(dir, `agy-stop-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.count`);
	try {
		mkdirSync(dir, { recursive: true });
		const count = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
		if (count >= 1) return { decision: "allow" };
		writeFileSync(counterFile, "1", { encoding: "utf8", flag: "w" });
		return { decision: "continue", reason: AGY_REPORT_NUDGE };
	} catch {
		// A hook must never block indefinitely. If state cannot be persisted, allow.
		return { decision: "allow" };
	}
}
