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

import {
	classifierChoices,
	modelChoices,
	type ModelRegistryLike,
	type RegistryModel,
} from "../../src/config/models.ts";

/** A registry whose provider display names differ from their ids, to catch that lookup. */
function registry(models: RegistryModel[]): ModelRegistryLike {
	return {
		getAvailable: () => models,
		getProviderDisplayName: (provider) => (provider === "oc-openai" ? "OC OpenAI" : provider),
	};
}

/**
 * A registry whose classifier list is its own, so a choice can only come from
 * `getModelsOfType` — the chat list stays empty and would show up as no rows.
 */
function classifierRegistry(models: RegistryModel[]): ModelRegistryLike {
	return {
		getAvailable: () => [],
		getModelsOfType: () => models,
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

/*
 * The classifier picker's rows. They come from `getModelsOfType("classifier")`
 * rather than `getAvailable()`: routing resolves the stored reference through
 * `findOfType`, so a chat model on the list would be a pick that later fails.
 */

test("classifier choices are the registry's classifier models as `provider/id` rows", () => {
	const choices = classifierChoices(
		classifierRegistry([
			{ provider: "oc-openai", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
			{ provider: "oc-openai", id: "deepseek-flash" },
			{ provider: "cc", id: "claude-sonnet-4" },
		]),
	);
	assert.deepEqual(
		choices.map((choice) => choice.value),
		["cc/claude-sonnet-4", "oc-openai/deepseek-flash", "oc-openai/glm-5.3-flash"],
	);
	// One column, and it is the exact reference the file will hold: provider first.
	assert.deepEqual(
		choices.map((choice) => choice.label),
		["cc/claude-sonnet-4", "oc-openai/deepseek-flash", "oc-openai/glm-5.3-flash"],
	);
	assert.deepEqual(
		choices.map((choice) => choice.description),
		[undefined, undefined, undefined],
	);
});

test("classifier choices never fall back to the chat model list", () => {
	const choices = classifierChoices({
		getAvailable: () => [{ provider: "chat", id: "chat-only" }],
		getModelsOfType: () => [{ provider: "cls", id: "classifier-only" }],
	});
	assert.deepEqual(choices.map((choice) => choice.value), ["cls/classifier-only"]);
});

test("no classifier list, no registry, or a throw offers no choices", () => {
	assert.deepEqual(classifierChoices(undefined), []);
	assert.deepEqual(classifierChoices({} as unknown as ModelRegistryLike), []);
	assert.deepEqual(classifierChoices({ getAvailable: () => [] }), []);
	// The pinned pi types have no `getModelsOfType`; a runtime that lacks it, or one
	// that throws reaching it, must degrade to an empty list rather than a crash.
	assert.deepEqual(
		classifierChoices({
			getAvailable: () => [],
			getModelsOfType: () => {
				throw new Error("registry exploded");
			},
		}),
		[],
	);
});

test("duplicate and malformed classifier entries never become rows", () => {
	const choices = classifierChoices(
		classifierRegistry([
			{ provider: "cc", id: "claude-sonnet-4" },
			{ provider: "cc", id: "claude-sonnet-4" },
			{ provider: "", id: "orphan" },
			{ provider: "cc", id: "" },
		]),
	);
	assert.deepEqual(choices.map((choice) => choice.value), ["cc/claude-sonnet-4"]);
});
