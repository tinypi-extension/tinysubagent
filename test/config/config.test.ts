import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	CONFIG_FILENAME,
	CURRENT_PROFILE,
	JSONC_CONFIG_FILENAME,
	configPath,
	configSources,
	defaultTarget,
	loadConfig,
	type LoadedConfig,
	settingsTargets,
} from "../../src/config/config.ts";

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

/**
 * Read one file as if it were the only config in both scopes. This is the single-
 * file shape most tests want; anything that asserts *layering* must instead use
 * {@link twoDirs}, or both scopes would point at the same file and prove nothing.
 */
function read(file: string): LoadedConfig {
	return loadConfig(path.dirname(file), path.dirname(file));
}

/** Two fresh, distinct temp dirs: the project cwd and the agent dir. */
function twoDirs(): { cwd: string; agentDir: string } {
	return {
		cwd: mkdtempSync(path.join(tmpdir(), "tinysubagent-project-")),
		agentDir: mkdtempSync(path.join(tmpdir(), "tinysubagent-agent-")),
	};
}

/** A file in the project scope, i.e. `<cwd>/.pi/<name>`. */
function writeProject(cwd: string, name: string, value: unknown): string {
	const dir = path.join(cwd, CONFIG_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

/** A file in the global scope, i.e. `<agentDir>/<name>`. */
function writeGlobal(agentDir: string, name: string, value: unknown): string {
	const file = path.join(agentDir, name);
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

/** Run with `PI_TINYSUBAGENT_CONFIG` set (or cleared), restoring it afterwards. */
function withEnv(value: string | undefined, run: () => void): void {
	const key = "PI_TINYSUBAGENT_CONFIG";
	const saved = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		run();
	} finally {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Single file: parse, normalise, and report
// ────────────────────────────────────────────────────────────────────────────

test("a missing config file disables profiles without warning", () => {
	const { config, warnings } = read(missingFile());
	assert.equal(config.enableProfiles, false);
	assert.deepEqual(config.profiles, {});
	// Missing is the documented default state, not a mistake worth reporting.
	assert.deepEqual(warnings, []);
});

test("malformed JSON disables profiles and says why", () => {
	const { config, warnings } = read(writeConfig("{ not json"));
	assert.equal(config.enableProfiles, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /not valid JSON/);
});

test("a non-object root disables profiles and says why", () => {
	const { config, warnings } = read(writeConfig([1, 2, 3]));
	assert.equal(config.enableProfiles, false);
	assert.match(warnings[0] ?? "", /must contain a JSON object/);
});

test("profiles stay off unless enableProfiles is literally true", () => {
	const file = writeConfig({ enableProfiles: "yes", profiles: { pro: { model: "m" } } });
	const { config } = read(file);
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
	const { config, warnings } = read(file);
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
	const { config, warnings } = read(file);
	assert.deepEqual(config.profiles.odd, { model: "m" });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /unknown "thinking" value/);
});

test("a profile with a non-string model drops only that field", () => {
	const file = writeConfig({
		enableProfiles: true,
		profiles: { odd: { model: 42, thinking: "high" } },
	});
	const { config, warnings } = read(file);
	assert.deepEqual(config.profiles.odd, { thinking: "high" });
	assert.match(warnings[0] ?? "", /non-string "model"/);
});

test("a non-object profile is ignored", () => {
	const file = writeConfig({ enableProfiles: true, profiles: { bad: "nope", good: { model: "m" } } });
	const { config, warnings } = read(file);
	assert.deepEqual(Object.keys(config.profiles), ["good"]);
	assert.match(warnings[0] ?? "", /is not an object/);
});

test("redefining the built-in current profile is refused", () => {
	const file = writeConfig({ enableProfiles: true, profiles: { [CURRENT_PROFILE]: { model: "m" } } });
	const { config, warnings } = read(file);
	assert.equal(CURRENT_PROFILE in config.profiles, false);
	assert.match(warnings[0] ?? "", /built-in profile/);
});

test("enableProfiles with no usable profiles warns that only current remains", () => {
	const file = writeConfig({ enableProfiles: true, profiles: {} });
	const { config, warnings } = read(file);
	assert.equal(config.enableProfiles, true);
	assert.match(warnings[0] ?? "", /only "current" is available/);
});

test("a non-object profiles field is ignored", () => {
	const file = writeConfig({ enableProfiles: true, profiles: ["nope"] });
	const { warnings } = read(file);
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
	const { config, warnings } = read(file);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(config.profiles, { pro: { model: "oc-openai/glm-5.3-flash", thinking: "high" } });
	assert.deepEqual(warnings, []);
});

test("a malformed .jsonc is reported as JSONC, not JSON", () => {
	const { config, warnings } = read(writeNamed(JSONC_CONFIG_FILENAME, "{ not json"));
	assert.equal(config.enableProfiles, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /tinysubagent\.jsonc is not valid JSONC/);
});

// ────────────────────────────────────────────────────────────────────────────
// Within a scope: `.jsonc` outranks `.json`
// ────────────────────────────────────────────────────────────────────────────

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

	assert.equal(configPath(dir, dir), path.join(dir, JSONC_CONFIG_FILENAME));
	// The shadowed .json is ignored silently, and that silence is the documented
	// behaviour — so there is no warning to assert against, only no trace of it.
	const { config, warnings } = loadConfig(dir, dir);
	assert.deepEqual(Object.keys(config.profiles), ["new"]);
	assert.deepEqual(warnings, []);
});

test("a .json is still used when it is the only file", () => {
	const dir = configDir();
	writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify({ enableProfiles: true }));
	assert.equal(configPath(dir, dir), path.join(dir, CONFIG_FILENAME));
	assert.deepEqual(
		configSources(dir, dir).map((source) => source.file),
		[path.join(dir, CONFIG_FILENAME)],
	);
});

test("a project .jsonc beats a project .json", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, CONFIG_FILENAME, { enableProfiles: true, profiles: { old: { model: "m" } } });
	const jsonc = writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { new: { model: "m" } },
	});

	assert.equal(configPath(cwd, agentDir), jsonc);
	const { config } = loadConfig(cwd, agentDir);
	assert.deepEqual(Object.keys(config.profiles), ["new"]);
});

// ────────────────────────────────────────────────────────────────────────────
// Between scopes: project outranks global, whatever the extension
// ────────────────────────────────────────────────────────────────────────────

test("a project file alone is read, with the global scope absent", () => {
	const { cwd, agentDir } = twoDirs();
	const file = writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { pro: { model: "m" } },
	});

	assert.equal(configPath(cwd, agentDir), file);
	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(config.profiles, { pro: { model: "m" } });
	assert.deepEqual(config.sources, [{ file, scope: "project" }]);
	assert.deepEqual(warnings, []);
});

test("a project .json beats a global .jsonc", () => {
	const { cwd, agentDir } = twoDirs();
	const projectJson = writeProject(cwd, CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { fromProject: { model: "project" } },
	});
	const globalJsonc = writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { fromGlobal: { model: "global" } },
	});

	// Scope beats filename: the extension is the within-directory tiebreak only.
	assert.equal(configPath(cwd, agentDir), projectJson);
	assert.deepEqual(
		configSources(cwd, agentDir).map((source) => source.file),
		[projectJson, globalJsonc],
	);
});

test("sources lists every contributing file, highest precedence first", () => {
	const { cwd, agentDir } = twoDirs();
	const project = writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { p: { model: "m" } },
	});
	const global = writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { g: { model: "m" } },
	});

	const { config } = loadConfig(cwd, agentDir);
	assert.deepEqual(config.sources, [
		{ file: project, scope: "project" },
		{ file: global, scope: "global" },
	]);
});

test("with no project file, resolution matches the global-only baseline", () => {
	const { cwd, agentDir } = twoDirs();
	const global = writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { pro: { model: "m" } },
	});

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(config.profiles, { pro: { model: "m" } });
	assert.deepEqual(config.sources, [{ file: global, scope: "global" }]);
	assert.deepEqual(warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// Layering: profiles merge by name, enableProfiles comes from the highest file
// ────────────────────────────────────────────────────────────────────────────

test("project profiles merge with global ones, and a name collision resolves to the project", () => {
	const { cwd, agentDir } = twoDirs();
	writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: {
			shared: { model: "global" },
			globalOnly: { model: "global-only" },
		},
	});
	writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: {
			shared: { model: "project" },
			projectOnly: { model: "project-only" },
		},
	});

	const { config } = loadConfig(cwd, agentDir);
	assert.deepEqual(config.profiles, {
		shared: { model: "project" },
		globalOnly: { model: "global-only" },
		projectOnly: { model: "project-only" },
	});
});

test("enableProfiles is inherited from global while profiles come from the project", () => {
	const { cwd, agentDir } = twoDirs();
	writeGlobal(agentDir, JSONC_CONFIG_FILENAME, { enableProfiles: true });
	writeProject(cwd, JSONC_CONFIG_FILENAME, { profiles: { pro: { model: "m" } } });

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(Object.keys(config.profiles), ["pro"]);
	// Together the two files add up to a usable config, so nothing is missing.
	assert.deepEqual(warnings, []);
});

test("a project file can switch enableProfiles off", () => {
	const { cwd, agentDir } = twoDirs();
	writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { pro: { model: "m" } },
	});
	writeProject(cwd, JSONC_CONFIG_FILENAME, { enableProfiles: false });

	const { config } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, false);
	// Only the switch is taken from the project file; the profiles still merge.
	assert.deepEqual(Object.keys(config.profiles), ["pro"]);
});

test("a project file defining profiles while enableProfiles is off stays silent", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, JSONC_CONFIG_FILENAME, { profiles: { pro: { model: "m" } } });

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, false);
	assert.deepEqual(Object.keys(config.profiles), ["pro"]);
	assert.deepEqual(warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// Failure: a bad file is skipped, and a lower scope can still carry the config
// ────────────────────────────────────────────────────────────────────────────

test("a malformed project file falls back to the global config", () => {
	const { cwd, agentDir } = twoDirs();
	const global = writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { pro: { model: "m" } },
	});
	writeProject(cwd, JSONC_CONFIG_FILENAME, "{ not json");

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, true);
	assert.deepEqual(Object.keys(config.profiles), ["pro"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /not valid JSONC/);
	assert.deepEqual(config.sources, [{ file: global, scope: "global" }]);
});

test("a malformed project file with no global config disables profiles", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, JSONC_CONFIG_FILENAME, "{ not json");

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, false);
	assert.deepEqual(config.profiles, {});
	assert.deepEqual(config.sources, []);
	assert.equal(warnings.length, 1);
});

test("a malformed file warning names the offending file", () => {
	const { cwd, agentDir } = twoDirs();
	const broken = writeProject(cwd, CONFIG_FILENAME, "{ not json");

	const { warnings } = loadConfig(cwd, agentDir);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]?.includes(broken), `warning did not name ${broken}: ${warnings[0]}`);
});

test("a profile warning names the file the profile came from", () => {
	const { cwd, agentDir } = twoDirs();
	const project = writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { bad: "nope", good: { model: "m" } },
	});

	const { warnings } = loadConfig(cwd, agentDir);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /is not an object/);
	assert.ok(warnings[0]?.includes(project), `warning did not name ${project}: ${warnings[0]}`);
});

test("the no-usable-profiles warning names the highest-precedence file", () => {
	const { cwd, agentDir } = twoDirs();
	writeGlobal(agentDir, JSONC_CONFIG_FILENAME, { enableProfiles: true });
	const project = writeProject(cwd, JSONC_CONFIG_FILENAME, {});

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /only "current" is available/);
	assert.ok(warnings[0]?.includes(project), `warning did not name ${project}: ${warnings[0]}`);
});

// ────────────────────────────────────────────────────────────────────────────
// Discovery: only files that exist are candidates
// ────────────────────────────────────────────────────────────────────────────

test("no config in either scope leaves no candidates and no path", () => {
	const { cwd, agentDir } = twoDirs();
	assert.deepEqual(configSources(cwd, agentDir), []);
	assert.equal(configPath(cwd, agentDir), null);

	const { config, warnings } = loadConfig(cwd, agentDir);
	assert.equal(config.enableProfiles, false);
	assert.deepEqual(config.sources, []);
	assert.deepEqual(warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// Override: the escape hatch, and it stops layering
// ────────────────────────────────────────────────────────────────────────────

test("the contributing files travel with the config, highest precedence first", () => {
	const jsoncFile = writeNamed(JSONC_CONFIG_FILENAME, { enableProfiles: true });
	assert.deepEqual(read(jsoncFile).config.sources, [{ file: jsoncFile, scope: "global" }]);

	const jsonFile = writeConfig({ enableProfiles: true });
	assert.deepEqual(read(jsonFile).config.sources, [{ file: jsonFile, scope: "global" }]);

	// A file that failed to parse contributed nothing, so a later message must not
	// name it as though it had been applied.
	const broken = writeNamed(JSONC_CONFIG_FILENAME, "{ nope");
	assert.deepEqual(read(broken).config.sources, []);
	assert.equal(read(broken).warnings.length, 1);
});

test("PI_TINYSUBAGENT_CONFIG beats a valid project file", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, JSONC_CONFIG_FILENAME, {
		enableProfiles: true,
		profiles: { fromProject: { model: "project" } },
	});
	const override = writeConfig({
		enableProfiles: true,
		profiles: { fromOverride: { model: "override" } },
	});

	withEnv(override, () => {
		const { config, warnings } = loadConfig(cwd, agentDir);
		assert.deepEqual(Object.keys(config.profiles), ["fromOverride"]);
		// Layering stops at the override: the project file is not read at all.
		assert.deepEqual(config.sources, [{ file: override, scope: "override" }]);
		assert.equal(configPath(cwd, agentDir), override);
		assert.deepEqual(warnings, []);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Settings screen: target selection mirrors resolution, in the screen's words
// ────────────────────────────────────────────────────────────────────────────

test("settingsTargets lists project before root, with exists from the filesystem", () => {
	const { cwd, agentDir } = twoDirs();
	const project = writeProject(cwd, JSONC_CONFIG_FILENAME, {});
	const root = writeGlobal(agentDir, CONFIG_FILENAME, {});

	assert.deepEqual(settingsTargets(cwd, agentDir), [
		{ scope: "project", file: project, exists: true },
		{ scope: "root", file: root, exists: true },
	]);
});

test("settingsTargets keeps the .jsonc-beats-.json rule within a scope", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, CONFIG_FILENAME, {});
	const projectJsonc = writeProject(cwd, JSONC_CONFIG_FILENAME, {});
	const rootJson = writeGlobal(agentDir, CONFIG_FILENAME, {});

	// The shadowed project .json and the root file are dropped: only the .jsonc
	// in each scope survives, and project still precedes root.
	assert.deepEqual(
		settingsTargets(cwd, agentDir).map((target) => target.file),
		[projectJsonc, rootJson],
	);
});

test("defaultTarget picks an existing project file over an existing root file", () => {
	const { cwd, agentDir } = twoDirs();
	const project = writeProject(cwd, JSONC_CONFIG_FILENAME, {});
	writeGlobal(agentDir, JSONC_CONFIG_FILENAME, {});

	assert.deepEqual(defaultTarget(cwd, agentDir), {
		scope: "project",
		file: project,
		exists: true,
	});
});

test("defaultTarget falls back to the root .jsonc with exists false when nothing exists", () => {
	const { cwd, agentDir } = twoDirs();

	assert.deepEqual(defaultTarget(cwd, agentDir), {
		scope: "root",
		file: path.join(agentDir, JSONC_CONFIG_FILENAME),
		exists: false,
	});
});

test("PI_TINYSUBAGENT_CONFIG yields a single override target, existing or not", () => {
	const { cwd, agentDir } = twoDirs();
	writeProject(cwd, JSONC_CONFIG_FILENAME, {});
	const existing = writeConfig({});

	withEnv(existing, () => {
		assert.deepEqual(settingsTargets(cwd, agentDir), [
			{ scope: "override", file: existing, exists: true },
		]);
		assert.deepEqual(defaultTarget(cwd, agentDir), {
			scope: "override",
			file: existing,
			exists: true,
		});
	});

	// The override is the user's explicit choice, so it is listed even when it
	// names nothing — and the scopes it would otherwise shadow are not listed.
	const missing = path.join(mkdtempSync(path.join(tmpdir(), "tinysubagent-config-")), "custom.json");
	withEnv(missing, () => {
		assert.deepEqual(settingsTargets(cwd, agentDir), [
			{ scope: "override", file: missing, exists: false },
		]);
	});
});

test("the config path can be overridden, which is what makes it testable", () => {
	const { cwd, agentDir } = twoDirs();
	const file = writeConfig({ enableProfiles: true, profiles: { pro: { model: "m" } } });

	withEnv(file, () => {
		assert.equal(configPath(cwd, agentDir), file);
		// The override is read even when neither scope has a file to fall back to.
		assert.equal(loadConfig(cwd, agentDir).config.enableProfiles, true);
		assert.deepEqual(Object.keys(loadConfig(cwd, agentDir).config.profiles), ["pro"]);

		// An explicit path beats the `.jsonc` preference: precedence between the two
		// default names only applies when neither has been overridden.
		const global = writeGlobal(agentDir, JSONC_CONFIG_FILENAME, { enableProfiles: false });
		assert.equal(configPath(cwd, agentDir), file);

		// Blank means "not set", so an empty variable cannot point at nothing — the
		// scopes take over and the global file is the winner.
		withEnv("   ", () => {
			assert.equal(configPath(cwd, agentDir), global);
		});
	});
});
