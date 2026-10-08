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
	/**
	 * The models pi can run as classifiers. Optional on purpose: the pinned pi types
	 * do not have it, and a runtime that lacks it must degrade to an empty list
	 * rather than break the screen.
	 */
	getModelsOfType?(type: "classifier"): readonly RegistryModel[];
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
	/** What the row shows: the model id, or the whole `value` when it shows that alone. */
	label: string;
	/** The row's second column, when it has one; absent when `label` is the whole row. */
	description?: string;
}

/**
 * Every model the registry can actually run, as picker rows.
 *
 * Sorted by label rather than left in registry order: the list is browsed by
 * name, and a stable order makes the row under the cursor predictable across
 * opens. Duplicates by value are dropped — one model must not appear twice.
 */
export function modelChoices(registry: ModelRegistryLike | undefined): ModelChoice[] {
	return choicesFrom(registry, availableModels(registry));
}

/**
 * The same rows, but over the models the registry can run as classifiers.
 *
 * Routing resolves the stored reference with `findOfType("classifier", ...)`, which
 * only sees these — offering the chat list would be offering picks that later fail to
 * resolve. Everything a registry cannot answer is an empty list: no member, no
 * registry, or a throw, so the screen degrades to its own empty state instead of
 * taking a keypress down with it.
 *
 * Each row is the `provider/id` value alone, with no second column: the classifier
 * row is read back as a reference to be checked against the file, so the provider
 * leads the row rather than sitting beside it.
 */
export function classifierChoices(registry: ModelRegistryLike | undefined): ModelChoice[] {
	return choicesFrom(registry, classifierModels(registry), true);
}

/** One registry snapshot as picker rows, sorted by label then value, de-duplicated. */
function choicesFrom(
	registry: ModelRegistryLike | undefined,
	models: readonly RegistryModel[],
	/** True when a row shows only the `provider/id` value — the classifier list. */
	valueOnly = false,
): ModelChoice[] {
	const found = new Map<string, ModelChoice>();
	for (const model of models) {
		if (!isUsable(model)) continue;
		const value = `${model.provider}/${model.id}`;
		if (found.has(value)) continue;
		if (valueOnly) {
			found.set(value, { value, label: value });
			continue;
		}
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

/**
 * The registry's classifier models, or nothing when it cannot name any. The throw
 * cannot escape a keypress, and a non-list answer is not a list to build rows from.
 */
function classifierModels(registry: ModelRegistryLike | undefined): readonly RegistryModel[] {
	try {
		const models = registry?.getModelsOfType?.("classifier");
		return Array.isArray(models) ? models : [];
	} catch {
		return [];
	}
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
