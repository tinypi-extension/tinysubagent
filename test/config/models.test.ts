/**
 * The model list and the typed-text rule behind the settings screen's picker.
 *
 * No terminal and no registry class: `ModelRegistryLike` is structural, so a
 * plain object stands in for pi's registry. That is the point of the split — the
 * decision of what the picker shows and what Enter writes is testable here, and
 * the screen only has to render it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	modelChoices,
	resolveTypedModel,
	type ModelRegistryLike,
	type RegistryModel,
	type TypedModel,
} from "../../src/config/models.ts";

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

test("empty text means no key at all, which is inherit", () => {
	const choices = modelChoices(registry(MODELS));
	assert.deepEqual(resolveTypedModel(choices, ""), { kind: "inherit" });
	assert.deepEqual(resolveTypedModel(choices, "   "), { kind: "inherit" });
});

test("a canonical reference and a known bare id resolve to the same value", () => {
	const choices = modelChoices(registry(MODELS));
	const canonical: TypedModel = { kind: "model", value: "oc-openai/glm-5.3-flash" };
	assert.deepEqual(resolveTypedModel(choices, "oc-openai/glm-5.3-flash"), canonical);
	assert.deepEqual(resolveTypedModel(choices, "glm-5.3-flash"), canonical);
	assert.deepEqual(resolveTypedModel(choices, "  claude-sonnet-4  "), {
		kind: "model",
		value: "cc/claude-sonnet-4",
	});
});

test("a fragment of an id resolves when it names exactly one model", () => {
	const choices = modelChoices(registry(MODELS));
	assert.deepEqual(resolveTypedModel(choices, "sonnet"), { kind: "model", value: "cc/claude-sonnet-4" });
	assert.deepEqual(resolveTypedModel(choices, "deepseek"), { kind: "model", value: "oc-openai/deepseek-flash" });
});

test("a fragment that names several models is a question, not a guess", () => {
	const choices = modelChoices(registry(MODELS));
	assert.deepEqual(resolveTypedModel(choices, "flash"), {
		kind: "ambiguous",
		matches: ["oc-openai/deepseek-flash", "oc-openai/glm-5.3-flash"],
	});
});

test("an id shared by two providers stays as typed rather than guessing a provider", () => {
	const choices = modelChoices(
		registry([
			{ provider: "cc", id: "shared" },
			{ provider: "oc-openai", id: "shared" },
		]),
	);
	assert.deepEqual(resolveTypedModel(choices, "shared"), {
		kind: "ambiguous",
		matches: ["cc/shared", "oc-openai/shared"],
	});
	// The canonical form names one model and is never ambiguous.
	assert.deepEqual(resolveTypedModel(choices, "cc/shared"), { kind: "model", value: "cc/shared" });
});

test("text the registry does not know is written as typed — the field is still free text", () => {
	const choices = modelChoices(registry(MODELS));
	assert.deepEqual(resolveTypedModel(choices, "oc-openai/not-a-model"), {
		kind: "model",
		value: "oc-openai/not-a-model",
	});
	assert.deepEqual(resolveTypedModel(choices, "my-local-llama"), { kind: "model", value: "my-local-llama" });
	assert.deepEqual(resolveTypedModel([], "anything"), { kind: "model", value: "anything" }, "no picker behaves like the old field");
});
