import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { CONFIG_FILENAME, CURRENT_PROFILE, JSONC_CONFIG_FILENAME, configPath, loadConfig } from "../src/config.ts";

function writeNamed(name: string, value: unknown): string {
	const dir = mkdtempSync(path.join(tmpdir(), "tinysubagent-config-"));
	const file = path.join(dir, name);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

function writeConfig(value: unknown): string {
	return writeNamed(CONFIG_FILENAME, value);
}

function missingFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "tinysubagent-config-")), CONFIG_FILENAME);
}

/** A directory holding a config file under one name, so precedence can be exercised. */
function configDir(): string {
	return mkdtempSync(path.join(tmpdir(), "tinysubagent-config-"));
}

test("a missing config file disables profiles without warning", () => {
	const { config, warnings } = loadConfig(missingFile());
	assert.equal(config.enableProfiles, false);
	assert.deepEqual(config.profiles, {});
	// Missing is the documented default state, not a mistake worth reporting.
	assert.deepEqual(warnings, []);
});

test("malformed JSON disables profiles and says why", () => {
	const { config, warnings } = loadConfig(writeConfig("{ not json"));
	assert.equal(config.enableProfiles, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /not valid JSON/);
});

test("a non-object root disables profiles and says why", () => {
	const { config, warnings } = loadConfig(writeConfig([1, 2, 3]));
	assert.equal(config.enableProfiles, false);
	assert.match(warnings[0] ?? "", /must contain a JSON object/);
});

test("profiles stay off unless enableProfiles is literally true", () => {
	const file = writeConfig({ enableProfiles: "yes", profiles: { pro: { model: "m" } } });
	const { config } = loadConfig(file);
	assert.equal(config.enableProfiles, false);
	// Parsed and retained even while disabled, so flipping the flag is enough.
	assert.deepEqual(config.profiles, { pro: { model: "m" } });
});

test("a valid config is read in full", () => {
	const file = writeConfig({
		enableProfiles: true,
		profiles: {
			light: { model: "oc-openai/deepseek-flash", thinking: "low" },
			core: { model: "oc-openai/deepseek-flash", thinking: "medium" },
			pro: { model: "oc-openai/glm-5.3-flash", thinking: "high" },
			ultra: { model: "oc-openai/deepseek-flash", thinking: "high" },
		},
	});
	const { config, warnings } = loadConfig(file);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(Object.keys(config.profiles).sort(), ["core", "light", "pro", "ultra"]);
	assert.deepEqual(config.profiles.pro, { model: "oc-openai/glm-5.3-flash", thinking: "high" });
	assert.deepEqual(warnings, []);
});

test("an unknown thinking level is dropped with a warning but keeps the model", () => {
	const file = writeConfig({
		enableProfiles: true,
		profiles: { odd: { model: "m", thinking: "ludicrous" } },
	});
	const { config, warnings } = loadConfig(file);
	assert.deepEqual(config.profiles.odd, { model: "m" });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /unknown "thinking" value/);
});

test("a profile with a non-string model drops only that field", () => {
	const file = writeConfig({
		enableProfiles: true,
		profiles: { odd: { model: 42, thinking: "high" } },
	});
	const { config, warnings } = loadConfig(file);
	assert.deepEqual(config.profiles.odd, { thinking: "high" });
	assert.match(warnings[0] ?? "", /non-string "model"/);
});

test("a non-object profile is ignored", () => {
	const file = writeConfig({ enableProfiles: true, profiles: { bad: "nope", good: { model: "m" } } });
	const { config, warnings } = loadConfig(file);
	assert.deepEqual(Object.keys(config.profiles), ["good"]);
	assert.match(warnings[0] ?? "", /is not an object/);
});

test("redefining the built-in current profile is refused", () => {
	const file = writeConfig({ enableProfiles: true, profiles: { [CURRENT_PROFILE]: { model: "m" } } });
	const { config, warnings } = loadConfig(file);
	assert.equal(CURRENT_PROFILE in config.profiles, false);
	assert.match(warnings[0] ?? "", /built-in profile/);
});

test("enableProfiles with no usable profiles warns that only current remains", () => {
	const file = writeConfig({ enableProfiles: true, profiles: {} });
	const { config, warnings } = loadConfig(file);
	assert.equal(config.enableProfiles, true);
	assert.match(warnings[0] ?? "", /only "current" is available/);
});

test("a non-object profiles field is ignored", () => {
	const file = writeConfig({ enableProfiles: true, profiles: ["nope"] });
	const { warnings } = loadConfig(file);
	assert.match(warnings[0] ?? "", /"profiles" must be an object/);
});

test("a .jsonc config is read with comments and trailing commas", () => {
	const file = writeNamed(
		JSONC_CONFIG_FILENAME,
		`{
	// Which models to offer. The comments are the whole point of the .jsonc name.
	"enableProfiles": true,
	/* blocks work too, and so does a URL: https://example.com/a//b */
	"profiles": {
		"pro": { "model": "oc-openai/glm-5.3-flash", "thinking": "high", },
	},
}`,
	);
	const { config, warnings } = loadConfig(file);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(config.profiles, { pro: { model: "oc-openai/glm-5.3-flash", thinking: "high" } });
	assert.deepEqual(warnings, []);
});

test("a .jsonc wins over a .json sitting next to it", () => {
	const dir = configDir();
	writeFileSync(
		path.join(dir, CONFIG_FILENAME),
		JSON.stringify({ enableProfiles: true, profiles: { old: { model: "m" } } }),
	);
	writeFileSync(
		path.join(dir, JSONC_CONFIG_FILENAME),
		'{ "enableProfiles": true, "profiles": { "new": { "model": "m" } } }',
	);

	assert.equal(configPath(dir), path.join(dir, JSONC_CONFIG_FILENAME));
	// The shadowed .json is ignored silently, and that silence is the documented
	// behaviour — so there is no warning to assert against, only no trace of it.
	const { config, warnings } = loadConfig(configPath(dir));
	assert.deepEqual(Object.keys(config.profiles), ["new"]);
	assert.deepEqual(warnings, []);
});

test("a .json is still used when it is the only file", () => {
	const dir = configDir();
	writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ enableProfiles: true }));
	assert.equal(configPath(dir), path.join(dir, CONFIG_FILENAME));
});

test("a malformed .jsonc is reported as JSONC, not JSON", () => {
	const { config, warnings } = loadConfig(writeNamed(JSONC_CONFIG_FILENAME, "{ not json"));
	assert.equal(config.enableProfiles, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /tinysubagent\.jsonc is not valid JSONC/);
});

test("the loaded filename travels with the config", () => {
	const jsonc = loadConfig(writeNamed(JSONC_CONFIG_FILENAME, { enableProfiles: true }));
	assert.equal(jsonc.config.source, JSONC_CONFIG_FILENAME);
	assert.equal(loadConfig(writeConfig({ enableProfiles: true })).config.source, CONFIG_FILENAME);
	// A config that failed to parse still knows which file it came from, so the
	// "profiles are disabled" error can name it.
	assert.equal(loadConfig(writeNamed(JSONC_CONFIG_FILENAME, "{ nope")).config.source, JSONC_CONFIG_FILENAME);
});

test("the config path can be overridden, which is what makes it testable", () => {
	const file = writeConfig({ enableProfiles: true, profiles: { pro: { model: "m" } } });
	const saved = process.env.PI_TINYSUBAGENT_CONFIG;
	process.env.PI_TINYSUBAGENT_CONFIG = file;
	try {
		// `loadConfig()` with no argument must honour the override, since that is how
		// the extension reads it.
		assert.equal(configPath(), file);
		assert.equal(loadConfig().config.enableProfiles, true);
		assert.deepEqual(Object.keys(loadConfig().config.profiles), ["pro"]);

		// An explicit path beats the `.jsonc` preference: precedence between the two
		// default names only applies when neither has been overridden.
		const dir = configDir();
		writeFileSync(path.join(dir, JSONC_CONFIG_FILENAME), JSON.stringify({ enableProfiles: false }));
		process.env.PI_TINYSUBAGENT_CONFIG = file;
		assert.equal(configPath(dir), file);

		// Blank means "not set", so an empty variable cannot point at nothing.
		process.env.PI_TINYSUBAGENT_CONFIG = "   ";
		assert.equal(configPath(), path.join(getAgentDir(), CONFIG_FILENAME));
	} finally {
		if (saved === undefined) delete process.env.PI_TINYSUBAGENT_CONFIG;
		else process.env.PI_TINYSUBAGENT_CONFIG = saved;
	}
});
