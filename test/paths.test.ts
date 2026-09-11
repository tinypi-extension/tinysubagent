import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { childExtensionPath, findPackageRoot, packageRoot, pluginDir, srcDir } from "../src/paths.ts";

// ────────────────────────────────────────────────────────────────────────────
// The shipped layout, resolved from module location rather than a hardcoded depth
// ────────────────────────────────────────────────────────────────────────────

test("pluginDir resolves to the shipped plugin with both files present", () => {
	const dir = pluginDir();
	assert.equal(existsSync(dir), true);
	assert.equal(statSync(dir).isDirectory(), true);
	assert.equal(existsSync(join(dir, "herdr-plugin.toml")), true);
	assert.equal(existsSync(join(dir, "dispatch.sh")), true);
});

test("childExtensionPath points at a file that exists on disk", () => {
	// The launch script passes this as pi's `-e` target: a path that does not
	// exist means the child loads no extension, so there is no report tool.
	assert.equal(existsSync(childExtensionPath), true);
	assert.equal(statSync(childExtensionPath).isFile(), true);
});

test("packageRoot is the repository root and srcDir sits directly under it", () => {
	// `npm test` runs from the repo root, so the resolver's answer must match it.
	const repoRoot = realpathSync(process.cwd());
	assert.equal(realpathSync(packageRoot), repoRoot);
	assert.equal(realpathSync(srcDir), join(repoRoot, "src"));
	assert.equal(existsSync(join(packageRoot, "package.json")), true);
});

// ────────────────────────────────────────────────────────────────────────────
// findPackageRoot, the walk that makes relocation safe
// ────────────────────────────────────────────────────────────────────────────

test("findPackageRoot walks up to the nearest package.json from a nested directory", () => {
	const root = mkdtempSync(join(tmpdir(), "tinysubagent-paths-"));
	try {
		writeFileSync(join(root, "package.json"), "{}\n");
		const nested = join(root, "one", "two");
		mkdirSync(nested, { recursive: true });
		// Two levels below the package.json, it still finds the root.
		assert.equal(findPackageRoot(nested), root);

		// A nearer package.json wins over the outer one.
		const deeper = join(nested, "three");
		mkdirSync(deeper);
		writeFileSync(join(nested, "package.json"), "{}\n");
		assert.equal(findPackageRoot(deeper), nested);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("findPackageRoot terminates and falls back to the start when none exists above", () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-paths-"));
	try {
		// No package.json above a temp dir, so the walk must stop instead of
		// throwing and hand back the starting directory for the link prompt.
		assert.equal(findPackageRoot(dir), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
