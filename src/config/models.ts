/**
 * The model list the settings screen's picker shows.
 *
 * This module is pure on purpose. The picker itself is a pi-tui `SelectList` and
 * needs a terminal to exist, but everything that decides *what* it shows is a
 * function of the registry snapshot — so it is tested without one. It also gives
 * the screen one place to look when the registry is absent (a session that never
 * configured a provider, or a caller that passed a bare context): an empty list.
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

/** One picker row: `value` is what gets written, `label` what is shown. */
export interface ModelChoice {
	/** `provider/id` — the canonical reference the config file holds. */
	value: string;
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
			label: model.id,
			// The name is the human half and may be missing; the provider label always is.
			description: model.name ? `${model.name} · ${provider}` : provider,
		});
	}
	return [...found.values()].sort(
		(a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value),
	);
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
