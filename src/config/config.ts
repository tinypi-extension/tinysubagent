/**
 * tinysubagent configuration: a standalone settings file read from two scopes,
 * layered highest precedence first:
 *
 *   project  <cwd>/.pi/tinysubagent.json(c)    what a repository ships for itself
 *   global   <agentDir>/tinysubagent.json(c)   what the user set up machine-wide
 *
 * `PI_TINYSUBAGENT_CONFIG` overrides both and is then the only file read. Within a
 * scope `.jsonc` wins over `.json` (so the file can carry comments), but scope beats
 * filename: a project `.json` still outranks a global `.jsonc`.
 *
 * Deliberately NOT nested under a key in `settings.json` — the whole point of
 * this extension is that its config does not entangle with pi's own settings
 * file, so it can be edited, diffed, and deleted independently.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
// Both filenames go through jsonc-parser, and its *defaults* are the dialect we
// want: comments and trailing commas legal, everything else plain JSON. So a
// `.json` that grows a comment keeps working — the filename picks precedence, not
// strictness.
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isThinkingLevel, type Profile } from "../types.ts";

/** Which scope a config file belongs to. Scope outranks the filename. */
export type ConfigScope = "override" | "project" | "global";

export interface ConfigSource {
	/** Absolute path of the file. */
	file: string;
	scope: ConfigScope;
}

export interface TinysubagentConfig {
	enableProfiles: boolean;
	profiles: Record<string, Profile>;
	/**
	 * Every file that was read successfully, highest precedence first. It rides
	 * along with the config so a message raised long after loading (a named profile
	 * requested while profiles are off) can still point at the right file. Empty
	 * when nothing was read.
	 */
	sources: ConfigSource[];
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

/**
 * The `PI_TINYSUBAGENT_CONFIG` override, if set, as the single candidate it is.
 * Blank means "not set", so an empty variable cannot point at nothing.
 */
function overrideSource(): ConfigSource | null {
	const override = process.env.PI_TINYSUBAGENT_CONFIG?.trim();
	return override ? { file: override, scope: "override" } : null;
}

/** One directory's existing config, if any: `.jsonc` wins over `.json`. */
function preferredSource(dir: string, scope: ConfigScope): ConfigSource[] {
	// `.jsonc` wins when both exist: writing one is enough to switch over, and the
	// leftover `.json` is then ignored without a warning. That is deliberate — the
	// alternative is a nag the user cannot get rid of short of deleting a file.
	const jsonc = path.join(dir, JSONC_CONFIG_FILENAME);
	if (existsSync(jsonc)) return [{ file: jsonc, scope }];
	const json = path.join(dir, CONFIG_FILENAME);
	return existsSync(json) ? [{ file: json, scope }] : [];
}

/**
 * The config files that exist, highest precedence first. A project file outranks a
 * global one regardless of extension; within a directory `.jsonc` outranks `.json`.
 * The `PI_TINYSUBAGENT_CONFIG` override is not listed here — it is resolved apart
 * from the scopes, since it need not be named like a config file at all.
 */
export function configSources(cwd: string, agentDir: string): ConfigSource[] {
	return [
		preferredSource(path.join(cwd, CONFIG_DIR_NAME), "project"),
		preferredSource(agentDir, "global"),
	].flat();
}

/**
 * The file resolution would start from, or `null` when there is none. For the
 * scopes this is a real "does the file exist" answer, not a synthesised default: a
 * caller asking for the path must be able to tell that there is nothing to read.
 * A `PI_TINYSUBAGENT_CONFIG` that is set is returned verbatim, even when it names a
 * file that does not exist — it is the user's explicit choice, and a blank value
 * meaning "unset" is what keeps the escape hatch testable.
 */
export function configPath(cwd: string, agentDir: string): string | null {
	const override = overrideSource();
	if (override) return override.file;
	return configSources(cwd, agentDir)[0]?.file ?? null;
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

function normalizeProfile(
	raw: unknown,
	name: string,
	file: string,
	warnings: string[],
): Profile | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`tinysubagent: profile "${name}" in ${file} is not an object; ignoring it.`);
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const profile: Profile = {};
	if (entry.model !== undefined) {
		if (typeof entry.model === "string" && entry.model.trim() !== "") {
			profile.model = entry.model.trim();
		} else {
			warnings.push(
				`tinysubagent: profile "${name}" in ${file} has a non-string "model"; ignoring that field.`,
			);
		}
	}
	if (entry.thinking !== undefined) {
		if (isThinkingLevel(entry.thinking)) {
			profile.thinking = entry.thinking;
		} else {
			warnings.push(
				`tinysubagent: profile "${name}" in ${file} has an unknown "thinking" value; ignoring that field.`,
			);
		}
	}
	return profile;
}

/**
 * Parse one file into a JSON object, or `undefined` after warning why it cannot
 * stand in. A file that fails here is skipped and resolution falls through to the
 * next scope, so a malformed project file cannot break a working global config.
 */
function readConfigObject(file: string, warnings: string[]): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`tinysubagent: ${file} could not be read (${message}); ignoring it.`);
		return undefined;
	}

	// jsonc-parser reports syntax errors instead of throwing, and keeps going after
	// the first one — the first is the one worth showing.
	const errors: ParseError[] = [];
	const raw = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0) {
		warnings.push(
			`tinysubagent: ${file} is not valid ${dialect(file)} ` +
				`(${describeParseError(errors[0])}); ignoring it.`,
		);
		return undefined;
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`tinysubagent: ${file} must contain a JSON object; ignoring it.`);
		return undefined;
	}
	return raw as Record<string, unknown>;
}

/** Fold one file's profiles in, overwriting same-named ones from lower scopes. */
function mergeProfiles(
	root: Record<string, unknown>,
	file: string,
	profiles: Record<string, Profile>,
	warnings: string[],
): void {
	if (root.profiles === undefined) return;
	if (typeof root.profiles !== "object" || root.profiles === null || Array.isArray(root.profiles)) {
		warnings.push(`tinysubagent: "profiles" must be an object in ${file}; ignoring it.`);
		return;
	}
	for (const [name, value] of Object.entries(root.profiles as Record<string, unknown>)) {
		if (name === CURRENT_PROFILE) {
			warnings.push(
				`tinysubagent: "${CURRENT_PROFILE}" is a built-in profile and cannot be redefined ` +
					`in ${file}; ignoring it.`,
			);
			continue;
		}
		const profile = normalizeProfile(value, name, file, warnings);
		if (profile) profiles[name] = profile;
	}
}

/**
 * Resolve the effective config from every existing scope. A missing file is not
 * an error and not a warning — it is the documented default state meaning
 * "profiles are off".
 *
 * Files layer rather than replace each other: `profiles` merge by name with the
 * higher scope winning, and `enableProfiles` comes from the highest-precedence
 * file that specifies the key. That is what lets a committed repo file add one
 * profile without restating a contributor's personal ones.
 *
 * Profiles are only active when `enableProfiles` is literally `true`. When it is
 * false, the `profile` parameter is removed from the tool schema entirely, so
 * the model is never offered a knob that does nothing.
 */
export function loadConfig(cwd: string, agentDir: string): LoadedConfig {
	const warnings: string[] = [];
	// The override short-circuits: it is the only candidate, so layering stops there
	// rather than falling through to a scope the user did not ask for.
	const override = overrideSource();
	const candidates = override ? [override] : configSources(cwd, agentDir);

	const profiles: Record<string, Profile> = {};
	const sources: ConfigSource[] = [];
	let enableProfiles = false;

	// Lowest precedence first, so a later (higher-precedence) read overwrites.
	for (const source of [...candidates].reverse()) {
		if (!existsSync(source.file)) continue;
		const root = readConfigObject(source.file, warnings);
		if (root === undefined) continue;
		// Highest precedence first on the result, whatever order they were read in.
		sources.unshift(source);
		if (Object.hasOwn(root, "enableProfiles")) {
			// Presence of the key, not its truthiness: specifying it is what hands the
			// decision to this scope. `=== true` stays the only way to switch it on, so
			// a typo cannot enable profiles.
			enableProfiles = root.enableProfiles === true;
		}
		mergeProfiles(root, source.file, profiles, warnings);
	}

	if (enableProfiles && Object.keys(profiles).length === 0) {
		const named = sources[0]?.file ?? CONFIG_FILENAME;
		warnings.push(
			`tinysubagent: enableProfiles is true but no usable profiles were defined in ${named}; ` +
				`only "${CURRENT_PROFILE}" is available.`,
		);
	}

	return { config: { enableProfiles, profiles, sources }, warnings };
}
