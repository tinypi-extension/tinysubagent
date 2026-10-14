/** Minimal, reversible management of agy's trusted-workspace list. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

function settingsPath(home: string): string {
	return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function readSettings(home: string): Record<string, unknown> {
	const file = settingsPath(home);
	if (!existsSync(file)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new Error(`cannot parse agy settings at ${file}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`invalid agy settings at ${file}`);
	}
	return value as Record<string, unknown>;
}

function writeSettings(home: string, settings: Record<string, unknown>): void {
	const file = settingsPath(home);
	mkdirSync(path.dirname(file), { recursive: true });
	const staging = `${file}.tinysubagent.tmp`;
	writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	try {
		// Rename over the original, atomically replacing the file.
		renameSync(staging, file);
	} catch (error) {
		try { rmSync(staging, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

/** Adds workspace unless it is already present; returns whether settings changed. */
export function addTrustedWorkspace(home: string, workspace: string): boolean {
	const settings = readSettings(home);
	const trusted = settings.trustedWorkspaces;
	if (trusted !== undefined && (!Array.isArray(trusted) || trusted.some((entry) => typeof entry !== "string"))) {
		throw new Error("invalid trustedWorkspaces in agy settings");
	}
	const entries = (trusted as string[] | undefined) ?? [];
	if (entries.includes(workspace)) return false;
	settings.trustedWorkspaces = [...entries, workspace];
	writeSettings(home, settings);
	return true;
}

/** Removes only this workspace; returns whether settings changed. */
export function removeTrustedWorkspace(home: string, workspace: string): boolean {
	const settings = readSettings(home);
	const trusted = settings.trustedWorkspaces;
	if (trusted === undefined) return false;
	if (!Array.isArray(trusted) || trusted.some((entry) => typeof entry !== "string")) {
		throw new Error("invalid trustedWorkspaces in agy settings");
	}
	const remaining = trusted.filter((entry) => entry !== workspace);
	if (remaining.length === trusted.length) return false;
	settings.trustedWorkspaces = remaining;
	writeSettings(home, settings);
	return true;
}
