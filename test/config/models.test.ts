/**
 * The model list behind the settings screen's picker.
 *
 * No terminal and no registry class: `ModelRegistryLike` is structural, so a
 * plain object stands in for pi's registry. That is the point of the split — the
 * decision of what the picker shows is testable here, and the screen only has to
 * render it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { modelChoices, type ModelRegistryLike, type RegistryModel } from "../../src/config/models.ts";

/** A registry whose provider display names differ from their ids, to catch that lookup. */
function registry(models: RegistryModel[]): ModelRegistryLike {
	return {
		getAvailable: () => models,
		getProviderDisplayName: (provider) => (provider === "oc-openai" ? "OC OpenAI" : provider),
	};
}

const MODELS: RegistryModel[] = [
	{ provider: "oc-openai", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
	{ provider: "oc-openai", id: "deepseek-flash" },
	{ provider: "cc", id: "claude-sonnet-4" },
];

test("no registry, or one that knows nothing, offers no choices", () => {
	assert.deepEqual(modelChoices(undefined), []);
	assert.deepEqual(modelChoices({ getAvailable: () => [] }), []);
	assert.deepEqual(modelChoices({} as unknown as ModelRegistryLike), []);
});

test("a model becomes one row: provider/id as its value, id as its label", () => {
	const choices = modelChoices(registry(MODELS));
	assert.deepEqual(
		choices.map((choice) => choice.value),
		["cc/claude-sonnet-4", "oc-openai/deepseek-flash", "oc-openai/glm-5.3-flash"],
	);
	assert.deepEqual(
		choices.map((choice) => choice.label),
		["claude-sonnet-4", "deepseek-flash", "glm-5.3-flash"],
	);
	// The name and the provider's display name share the description; a model with
	// no name shows the provider alone rather than an empty half.
	assert.equal(choices[2]?.description, "GLM 5.3 Flash · OC OpenAI");
	assert.equal(choices[1]?.description, "OC OpenAI");
});

test("a provider with no display name falls back to its id", () => {
	const choices = modelChoices({ getAvailable: () => [{ provider: "cc", id: "claude-sonnet-4" }] });
	assert.equal(choices[0]?.description, "cc");
});

test("duplicates and malformed entries never become rows", () => {
	const choices = modelChoices(
		registry([
			{ provider: "cc", id: "claude-sonnet-4" },
			{ provider: "cc", id: "claude-sonnet-4" },
			{ provider: "", id: "orphan" },
			{ provider: "cc", id: "" },
		]),
	);
	assert.deepEqual(choices.map((choice) => choice.value), ["cc/claude-sonnet-4"]);
});
