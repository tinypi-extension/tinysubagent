import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CURRENT_PROFILE, JSONC_CONFIG_FILENAME, type TinysubagentConfig } from "../../src/config/config.ts";
import {
	availableProfileNames,
	profileParamDescription,
	resolveProfile,
	resolvedProfileLabel,
} from "../../src/config/profiles.ts";

const PARENT = { model: "oc-openai/deepseek-flash", thinking: "medium" as const };

function enabled(profiles: TinysubagentConfig["profiles"]): TinysubagentConfig {
	return { enableProfiles: true, profiles, sources: [] };
}

const CONFIGURED = enabled({
	light: { model: "oc-openai/deepseek-flash", thinking: "low" },
	pro: { model: "oc-openai/glm-5.3-flash", thinking: "high" },
	modelOnly: { model: "oc-openai/hy3" },
});

test("current always resolves to the orchestrator's own model and thinking", () => {
	const r = resolveProfile(CONFIGURED, CURRENT_PROFILE, PARENT);
	assert.deepEqual(r, { ok: true, name: "current", model: PARENT.model, thinking: PARENT.thinking });
});

test("a named profile overrides both fields", () => {
	const r = resolveProfile(CONFIGURED, "pro", PARENT);
	assert.deepEqual(r, { ok: true, name: "pro", model: "oc-openai/glm-5.3-flash", thinking: "high" });
});

test("a profile that sets only a model inherits the parent's thinking", () => {
	const r = resolveProfile(CONFIGURED, "modelOnly", PARENT);
	assert.deepEqual(r, { ok: true, name: "modelOnly", model: "oc-openai/hy3", thinking: "medium" });
});

test("an undefined parent model leaves the field undefined for the child to resolve", () => {
	const r = resolveProfile(CONFIGURED, CURRENT_PROFILE, {});
	assert.deepEqual(r, { ok: true, name: "current", model: undefined, thinking: undefined });
});

test("an unknown profile is rejected and the alternatives listed", () => {
	const r = resolveProfile(CONFIGURED, "nope", PARENT);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /unknown profile "nope"/);
	for (const name of ["current", "light", "pro", "modelOnly"]) assert.ok(r.error.includes(name), name);
});

test("an omitted profile inherits the parent, whether or not profiles are enabled", () => {
	// The schema marks `profile` optional, so omission is the common case, not a
	// mistake. It must mean the same thing in both configurations: the parameter's
	// presence only ever *adds* options, it does not change the default.
	const inherited = {
		ok: true,
		name: CURRENT_PROFILE,
		model: PARENT.model,
		thinking: PARENT.thinking,
	};
	for (const name of [undefined, "", "   "]) {
		const enabled = resolveProfile(CONFIGURED, name, PARENT);
		const disabled = resolveProfile({ enableProfiles: false, profiles: {}, sources: [] }, name, PARENT);
		assert.deepEqual(enabled, inherited);
		assert.deepEqual(disabled, inherited);
	}
});

test("a profile name is trimmed rather than treated as unknown", () => {
	const r = resolveProfile(CONFIGURED, "  pro  ", PARENT);
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.name, "pro");
});

test("when profiles are disabled an omitted profile inherits the parent", () => {
	const disabled: TinysubagentConfig = { enableProfiles: false, profiles: {}, sources: [] };
	assert.deepEqual(resolveProfile(disabled, undefined, PARENT), {
		ok: true,
		name: CURRENT_PROFILE,
		model: PARENT.model,
		thinking: PARENT.thinking,
	});
});

test("when profiles are disabled `current` is still a harmless no-op", () => {
	// A replayed call or a long-lived session must not fail for a request
	// that resolves to exactly the same thing as omitting it.
	const disabled: TinysubagentConfig = { enableProfiles: false, profiles: {}, sources: [] };
	assert.deepEqual(resolveProfile(disabled, CURRENT_PROFILE, PARENT), {
		ok: true,
		name: CURRENT_PROFILE,
		model: PARENT.model,
		thinking: PARENT.thinking,
	});
});

test("when profiles are disabled a named profile is refused even if configured", () => {
	const disabled: TinysubagentConfig = {
		enableProfiles: false,
		profiles: { pro: { model: "m" } },
		sources: [],
	};
	const r = resolveProfile(disabled, "pro", PARENT);
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /profiles are disabled/);
});

test("the refusal names the config file that was actually loaded", () => {
	const disabled: TinysubagentConfig = {
		enableProfiles: false,
		profiles: {},
		sources: [{ file: JSONC_CONFIG_FILENAME, scope: "global" }],
	};
	const r = resolveProfile(disabled, "pro", PARENT);
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /is not true in tinysubagent\.jsonc/);
});

test("availableProfileNames lists current first, then configured names sorted", () => {
	assert.deepEqual(availableProfileNames(CONFIGURED), ["current", "light", "modelOnly", "pro"]);
	assert.deepEqual(availableProfileNames({ enableProfiles: false, profiles: {}, sources: [] }), ["current"]);
});

test("the profile parameter description enumerates the real options", () => {
	const text = profileParamDescription(CONFIGURED);
	for (const name of ["current", "light", "pro", "modelOnly"]) assert.ok(text.includes(`\`${name}\``), name);
	assert.ok(text.includes("inherit this session's model"), "explains current");
	assert.ok(text.includes("oc-openai/glm-5.3-flash"), "shows what pro means");
});

test("the profile description degrades honestly when nothing is configured", () => {
	const text = profileParamDescription({ enableProfiles: true, profiles: {}, sources: [] });
	assert.ok(text.includes("`current`"));
	assert.equal(text.includes("Configured:"), false);
});

test("resolvedProfileLabel omits absent fields", () => {
	assert.equal(resolvedProfileLabel({ name: "pro", model: "m", thinking: "high" }), "pro (m, high)");
	assert.equal(resolvedProfileLabel({ name: "current" }), "current");
	assert.equal(resolvedProfileLabel({ name: "current", thinking: "high" }), "current (high)");
});
