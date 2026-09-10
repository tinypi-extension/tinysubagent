/**
 * tinysubagent configuration: a standalone `~/.pi/agent/tinysubagent.json`, or
 * `tinysubagent.jsonc` when you want to leave comments in it.
 *
 * Deliberately NOT nested under a key in `settings.json` — the whole point of
 * this extension is that its config does not entangle with pi's own settings
 * file, so it can be edited, diffed, and deleted independently.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// Both filenames go through jsonc-parser, and its *defaults* are the dialect we
// want: comments and trailing commas legal, everything else plain JSON. So a
// `.json` that grows a comment keeps working — the filename picks precedence, not
// strictness.
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isThinkingLevel, type Profile } from "./types.ts";

export interface TinysubagentConfig {
	enableProfiles: boolean;
	profiles: Record<string, Profile>;
	/**
	 * Document metadata rather than something a user writes: the basename the
	 * config was read from. It rides along with the config so a message raised long
	 * after loading (a named profile requested while profiles are off) can still
	 * point at the right file. Undefined when nothing was read.
	 */
	source?: string;
}

/** The implicit profile meaning "inherit the orchestrator's model and thinking". */
export const CURRENT_PROFILE = "current";

export const CONFIG_FILENAME = "tinysubagent.json";

/** Preferred over {@link CONFIG_FILENAME} when both exist, so the file can carry comments. */
export const JSONC_CONFIG_FILENAME = "tinysubagent.jsonc";

/**
 * A config could not be read as configured, but the extension must still load.
 * Warnings are surfaced through the tool description and `session_start` notify
 * rather than thrown, so a typo in this file never silently disables delegation.
 */
export interface LoadedConfig {
	config: TinysubagentConfig;
	warnings: string[];
}

export function configPath(agentDir: string = getAgentDir()): string {
	// An explicit path wins, which is what makes the config testable (and lets a
	// user point at a checked-in file for a project).
	const override = process.env.PI_TINYSUBAGENT_CONFIG?.trim();
	if (override) return override;
	// `.jsonc` wins when both exist: writing one is enough to switch over, and the
	// leftover `.json` is then ignored without a warning. That is deliberate — the
	// alternative is a nag the user cannot get rid of short of deleting a file.
	const jsonc = path.join(agentDir, JSONC_CONFIG_FILENAME);
	return existsSync(jsonc) ? jsonc : path.join(agentDir, CONFIG_FILENAME);
}

/**
 * What to call the file's dialect in a message. The extension decides this, not
 * the parser: a `.jsonc` is reported as JSONC even though both filenames are read
 * by the same lenient parser.
 */
function dialect(file: string): string {
	return path.extname(file).toLowerCase() === ".jsonc" ? "JSONC" : "JSON";
}

function describeParseError(error: ParseError | undefined): string {
	if (!error) return "unparseable";
	return `${printParseErrorCode(error.error)} at offset ${error.offset}`;
}

function normalizeProfile(raw: unknown, name: string, warnings: string[]): Profile | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`tinysubagent: profile "${name}" is not an object; ignoring it.`);
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const profile: Profile = {};
	if (entry.model !== undefined) {
		if (typeof entry.model === "string" && entry.model.trim() !== "") {
			profile.model = entry.model.trim();
		} else {
			warnings.push(`tinysubagent: profile "${name}" has a non-string "model"; ignoring that field.`);
		}
	}
	if (entry.thinking !== undefined) {
		if (isThinkingLevel(entry.thinking)) {
			profile.thinking = entry.thinking;
		} else {
			warnings.push(
				`tinysubagent: profile "${name}" has an unknown "thinking" value; ignoring that field.`,
			);
		}
	}
	return profile;
}

/**
 * Read the config file. A missing file is not an error and not a warning — it
 * is the documented default state meaning "profiles are off".
 *
 * Profiles are only active when `enableProfiles` is literally `true`. When it is
 * false, the `profile` parameter is removed from the tool schema entirely, so
 * the model is never offered a knob that does nothing.
 */
export function loadConfig(file: string = configPath()): LoadedConfig {
	const warnings: string[] = [];
	// Basename only: messages read better, and the full path is long enough to wrap
	// in a notify. It travels with the config so a later error can still name the
	// file that produced it.
	const source = path.basename(file);
	const disabled = (): TinysubagentConfig => ({ enableProfiles: false, profiles: {}, source });

	if (!existsSync(file)) return { config: disabled(), warnings };

	let raw: unknown;
	const errors: ParseError[] = [];
	try {
		raw = parseJsonc(readFileSync(file, "utf-8"), errors, {
			allowTrailingComma: true,
			disallowComments: false,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: disabled(),
			warnings: [`tinysubagent: ${file} could not be read (${message}); profiles are disabled.`],
		};
	}

	// jsonc-parser reports syntax errors instead of throwing, and keeps going after
	// the first one — the first is the one worth showing.
	if (errors.length > 0) {
		return {
			config: disabled(),
			warnings: [
				`tinysubagent: ${file} is not valid ${dialect(file)} ` +
					`(${describeParseError(errors[0])}); profiles are disabled.`,
			],
		};
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			config: disabled(),
			warnings: [`tinysubagent: ${file} must contain a JSON object; profiles are disabled.`],
		};
	}

	const root = raw as Record<string, unknown>;
	const enableProfiles = root.enableProfiles === true;
	const profiles: Record<string, Profile> = {};

	if (root.profiles !== undefined) {
		if (typeof root.profiles !== "object" || root.profiles === null || Array.isArray(root.profiles)) {
			warnings.push(`tinysubagent: "profiles" must be an object; ignoring it.`);
		} else {
			for (const [name, value] of Object.entries(root.profiles as Record<string, unknown>)) {
				if (name === CURRENT_PROFILE) {
					warnings.push(
						`tinysubagent: "${CURRENT_PROFILE}" is a built-in profile and cannot be redefined; ignoring it.`,
					);
					continue;
				}
				const profile = normalizeProfile(value, name, warnings);
				if (profile) profiles[name] = profile;
			}
		}
	}

	if (enableProfiles && Object.keys(profiles).length === 0) {
		warnings.push(
			`tinysubagent: enableProfiles is true but no usable profiles were defined in ${file}; ` +
				`only "${CURRENT_PROFILE}" is available.`,
		);
	}

	return { config: { enableProfiles, profiles, source }, warnings };
}
