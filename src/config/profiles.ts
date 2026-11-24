/**
 * Profile resolution.
 *
 * A profile is just a `{ model, thinking }` pair the child is launched with.
 * The built-in `current` profile means "inherit the orchestrator's model and
 * thinking level" and is always available, whether or not the config file
 * defines any profiles of its own.
 *
 * When `enableProfiles` is false the `profile` parameter is stripped from the
 * tool schema, so this module is only reachable with a profile name if a stale
 * session replays a call — which is reported as an error rather than ignored.
 *
 * The supervision mode is an input here, because a profile is only usable where
 * its harness can run: an agy profile is configured and valid in a pane host, and
 * is neither offered nor accepted under a plain terminal.
 */

import { harnessFor, harnessRunsIn, type LaunchMode } from "../children/harness/index.ts";
import { CURRENT_PROFILE, owningConfigFile, type TinysubagentConfig } from "./config.ts";
import type { Harness, Profile, ThinkingLevel } from "../types.ts";

/** Model + thinking of the orchestrator, used as the fallback for every profile. */
export interface ParentDefaults {
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * The triple a child was launched with: which profile was asked for, and the
 * `{ model, thinking }` it actually resolved to.
 *
 * Kept structured rather than as one pre-formatted label because the two
 * consumers want different things from it — the result message wants the label,
 * the spawn acknowledgment colours the parts — and a label cannot be split back
 * into its parts without guessing.
 */
export interface ResolvedProfile {
	name: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** `pi` when absent; only named profiles can carry `agy`. */
	harness?: Harness;
}

export type ProfileResolution =
	| ({ ok: true } & ResolvedProfile)
	| {
			ok: false;
			error: string;
			/**
			 * The profile exists and profiles are on, but this terminal's supervision
			 * mode cannot run it. A batch fails only this child, because the request is
			 * sound and its siblings may well be runnable here.
			 */
			unavailable?: true;
	  };

/**
 * The offered profile names: `current` first, then the configured names that can
 * run under `mode`, alphabetically. This is the one list — the routing
 * candidates, the `profile` parameter's prose and the unknown-name error all
 * derive from it, so no call site can offer what this terminal cannot start.
 *
 * `current` is never filtered: it is this session's own model and thinking, which
 * needs no child process at all.
 */
export function availableProfileNames(config: TinysubagentConfig, mode: LaunchMode = "pane"): string[] {
	return [
		CURRENT_PROFILE,
		...Object.keys(config.profiles)
			.filter((name) => harnessRunsIn(config.profiles[name]!, mode))
			.sort(),
	];
}

/**
 * Description text for the `profile` parameter, listing the real options so the
 * model does not have to guess or read the config file.
 */
export function profileParamDescription(
	config: TinysubagentConfig,
	autoRoute = false,
	mode: LaunchMode = "pane",
): string {
	const names = availableProfileNames(config, mode);
	const configured = names.filter((name) => name !== CURRENT_PROFILE);
	const lines = [
		`Usually omit this parameter unless a specific profile is required. Available profiles: ${names.map((n) => `\`${n}\``).join(", ")}.`,
		autoRoute
			? "Omit it to choose a profile automatically for this task."
			: `Omit it to inherit this session's model and thinking level, which is what \`${CURRENT_PROFILE}\` means.`,
	];
	if (configured.length > 0) {
		const detail = configured
			.map((name) => {
				const profile = config.profiles[name];
				const parts = [profile?.harness === "agy" ? "agy" : undefined, profile?.model, profile?.thinking].filter(Boolean);
				return `\`${name}\`${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
			})
			.join(", ");
		lines.push(`Configured: ${detail}.`);
	}
	return lines.join(" ");
}

/** One-line form of a resolved profile: `current (oc-openai/deepseek-flash, medium)`. */
export function resolvedProfileLabel(resolution: ResolvedProfile): string {
	const parts = [
		resolution.harness === "agy" ? "agy" : undefined,
		resolution.model,
		resolution.thinking,
	].filter(Boolean);
	return parts.length > 0 ? `${resolution.name} (${parts.join(", ")})` : resolution.name;
}

export function resolveProfile(
	config: TinysubagentConfig,
	name: string | undefined,
	parent: ParentDefaults,
	mode: LaunchMode = "pane",
): ProfileResolution {
	const wanted = name?.trim() ?? "";

	// An absent profile means "run on my own model and thinking" — which is exactly
	// what `current` means. The parameter is optional in the schema, so this is the
	// common case rather than a mistake, and it must behave the same whether or not
	// profiles are enabled.
	if (wanted === "" || wanted === CURRENT_PROFILE) {
		return { ok: true, name: CURRENT_PROFILE, model: parent.model, thinking: parent.thinking };
	}

	if (!config.enableProfiles) {
		// Any *named* profile is refused when profiles are off, because that is a
		// request this configuration genuinely cannot honour.
		return {
			ok: false,
			error:
				`profile "${wanted}" cannot be used: profiles are disabled ` +
				`("enableProfiles" is not true in ${owningConfigFile(config.sources)}). ` +
				`Only "${CURRENT_PROFILE}" is available.`,
		};
	}

	const profile: Profile | undefined = config.profiles[wanted];
	if (!profile) {
		return {
			ok: false,
			error: `unknown profile "${wanted}". Available: ${availableProfileNames(config, mode).join(", ")}.`,
		};
	}

	// A real profile this terminal cannot start: refused by name and by reason, so
	// the model learns why rather than being told the name does not exist.
	if (!harnessRunsIn(profile, mode)) {
		return {
			ok: false,
			unavailable: true,
			error:
				`profile "${wanted}" cannot be used here: its harness "${harnessFor(profile).id}" needs a pane host, ` +
				`and this terminal has none. Available here: ${availableProfileNames(config, mode).join(", ")}.`,
		};
	}

	const resolved: { ok: true } & ResolvedProfile = {
		ok: true,
		name: wanted,
		model: profile.model ?? parent.model,
		thinking: profile.thinking ?? parent.thinking,
	};
	if (profile.harness !== undefined) resolved.harness = profile.harness;
	return resolved;
}
