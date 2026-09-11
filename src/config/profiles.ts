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
 */

import * as path from "node:path";
import { CONFIG_FILENAME, CURRENT_PROFILE, type TinysubagentConfig } from "./config.ts";
import type { Profile, ThinkingLevel } from "../types.ts";

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
}

export type ProfileResolution = ({ ok: true } & ResolvedProfile) | { ok: false; error: string };

/** `current` first, then configured names alphabetically. */
export function availableProfileNames(config: TinysubagentConfig): string[] {
	return [CURRENT_PROFILE, ...Object.keys(config.profiles).sort()];
}

/**
 * Description text for the `profile` parameter, listing the real options so the
 * model does not have to guess or read the config file.
 */
export function profileParamDescription(config: TinysubagentConfig): string {
	const names = availableProfileNames(config);
	const configured = names.filter((name) => name !== CURRENT_PROFILE);
	const lines = [
		`Model/thinking profile for this subagent. One of: ${names.map((n) => `\`${n}\``).join(", ")}.`,
		`Omit it to inherit this session's model and thinking level, which is what \`${CURRENT_PROFILE}\` means.`,
	];
	if (configured.length > 0) {
		const detail = configured
			.map((name) => {
				const profile = config.profiles[name];
				const parts = [profile?.model, profile?.thinking].filter(Boolean);
				return `\`${name}\`${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
			})
			.join(", ");
		lines.push(`Configured: ${detail}.`);
	}
	return lines.join(" ");
}

/** One-line form of a resolved profile: `current (oc-openai/deepseek-flash, medium)`. */
export function resolvedProfileLabel(resolution: ResolvedProfile): string {
	const parts = [resolution.model, resolution.thinking].filter(Boolean);
	return parts.length > 0 ? `${resolution.name} (${parts.join(", ")})` : resolution.name;
}

export function resolveProfile(
	config: TinysubagentConfig,
	name: string | undefined,
	parent: ParentDefaults,
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
		// request this configuration genuinely cannot honour. The highest-precedence
		// file is the one that owned the switch, so it is the one to name — as a
		// basename, because this string ends up in a tool error, not a log.
		const source = config.sources[0];
		const named = source ? path.basename(source.file) : CONFIG_FILENAME;
		return {
			ok: false,
		error:
			`profile "${wanted}" cannot be used: profiles are disabled ` +
			`("enableProfiles" is not true in ${named}). ` +
			`Only "${CURRENT_PROFILE}" is available.`,
		};
	}

	const profile: Profile | undefined = config.profiles[wanted];
	if (!profile) {
		return {
			ok: false,
			error: `unknown profile "${wanted}". Available: ${availableProfileNames(config).join(", ")}.`,
		};
	}

	return {
		ok: true,
		name: wanted,
		model: profile.model ?? parent.model,
		thinking: profile.thinking ?? parent.thinking,
	};
}
