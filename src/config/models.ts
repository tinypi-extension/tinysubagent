/**
 * The model list the settings screen offers, and the rule that turns typed text
 * into the string a `model` key holds.
 *
 * This module is pure on purpose. The picker itself is a pi-tui `SelectList` and
 * needs a terminal to exist, but everything that decides *what* it shows and
 * *what* an Enter writes is a function of the registry snapshot and a string —
 * so it is tested without one. It also gives the screen one place to look when
 * the registry is absent (a session that never configured a provider, or a
 * caller that passed a bare context): an empty list, and a free-text field that
 * behaves exactly as it did before the picker existed.
 */

/** What this module needs off a `ModelRegistry`; kept structural so tests can fake it. */
export interface ModelRegistryLike {
	/** Models whose provider has credentials — the same set `/model` offers. */
	getAvailable(): readonly RegistryModel[];
	/** Provider id as the user should read it; falls back to the id itself. */
	getProviderDisplayName?(provider: string): string;
}

/** The three fields of a `Model` this module reads. */
export interface RegistryModel {
	provider: string;
	id: string;
	name?: string;
}

/** What the typed text means: a key removal, one model, or a question. */
export type TypedModel =
	| { kind: "inherit" }
	| { kind: "model"; value: string }
	| { kind: "ambiguous"; matches: readonly string[] };

/** One picker row: `value` is what gets written, `label` what is shown. */
export interface ModelChoice {
	/** `provider/id` — the canonical reference the config file holds. */
	value: string;
	/** The bare id, kept for resolving what the user typed by hand. */
	id: string;
	label: string;
	description: string;
}

/**
 * Every model the registry can actually run, as picker rows.
 *
 * Sorted by label rather than left in registry order: the list is browsed by
 * name, and a stable order makes the row under the cursor predictable across
 * opens. Duplicates by value are dropped — one model must not appear twice.
 */
export function modelChoices(registry: ModelRegistryLike | undefined): ModelChoice[] {
	const found = new Map<string, ModelChoice>();
	for (const model of availableModels(registry)) {
		if (!isUsable(model)) continue;
		const value = `${model.provider}/${model.id}`;
		if (found.has(value)) continue;
		const provider = registry?.getProviderDisplayName?.(model.provider) ?? model.provider;
		found.set(value, {
			value,
			id: model.id,
			label: model.id,
			// The name is the human half and may be missing; the provider label always is.
			description: model.name ? `${model.name} · ${provider}` : provider,
		});
	}
	return [...found.values()].sort(
		(a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value),
	);
}

/**
 * The `model` value a typed string means, or `undefined` for "no key at all"
 * (which downstream reads as "inherit this session's model").
 *
 * Typing is not the same as picking. The picker filters on `value` — a prefix of
 * `provider/id` — so neither a bare id (`glm-5.3-flash`) nor a fragment
 * (`sonnet`) matches a row even when the registry knows the model, and pi's own
 * resolver accepts a bare id only when it is unambiguous. Resolving here means
 * the file gets the canonical form either way, a string that names nothing is
 * still written as typed — the field was free text before the picker existed,
 * and the registry is not the whole world (providers not logged in, models pi
 * has not fetched) — and a string that names several models is refused rather
 * than resolved to whichever one happened to sort first.
 */
export function resolveTypedModel(choices: readonly ModelChoice[], typed: string): TypedModel {
	const text = typed.trim();
	// Empty is the inherit case, not an empty model.
	if (text === "") return { kind: "inherit" };
	if (choices.some((choice) => choice.value === text)) return { kind: "model", value: text };
	const lowered = text.toLowerCase();
	const byId = choices.filter((choice) => choice.id.toLowerCase() === lowered);
	if (byId.length > 0) return named(byId);
	// A fragment, as the picker's own search is a fragment search. Ids first so that
	// "sonnet" finds `claude-sonnet-4` before a provider id halfway matches.
	const byFragment = choices.filter(
		(choice) =>
			choice.id.toLowerCase().includes(lowered) || choice.value.toLowerCase().includes(lowered),
	);
	return byFragment.length > 0 ? named(byFragment) : { kind: "model", value: text };
}

/** One match is the model; several are a question only the user can answer. */
function named(matches: ModelChoice[]): TypedModel {
	if (matches.length === 1) return { kind: "model", value: matches[0]!.value };
	return { kind: "ambiguous", matches: matches.map((choice) => choice.value) };
}

/** The registry's snapshot, or nothing when there is no registry to ask. */
function availableModels(registry: ModelRegistryLike | undefined): readonly RegistryModel[] {
	if (!registry || typeof registry.getAvailable !== "function") return [];
	return registry.getAvailable();
}

/** A malformed entry is skipped rather than rendered as a row that cannot be written. */
function isUsable(model: RegistryModel | undefined): model is RegistryModel {
	return (
		typeof model?.provider === "string" &&
		model.provider !== "" &&
		typeof model.id === "string" &&
		model.id !== ""
	);
}
