import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { stopHookDecision } from "../../src/children/agy-stop-hook.ts";
import { addTrustedWorkspace, removeTrustedWorkspace } from "../../src/children/agy-trust.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "tinysubagent-stop-hook-"));
	const context = join(root, "context");
	const report = join(root, "report.done");
	return { root, context, report, payload: { conversationId: "conv-1", artifactDirectoryPath: root } };
}

test("a valid done sidecar allows agy to stop", () => {
	const fixture = setup();
	try {
		writeFileSync(fixture.report, JSON.stringify({ type: "done", result: "ok" }));
		assert.deepEqual(stopHookDecision(fixture.payload, fixture.report), { decision: "allow" });
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a valid failed sidecar allows agy to stop", () => {
	const fixture = setup();
	try {
		writeFileSync(fixture.report, JSON.stringify({ type: "failed", reason: "error" }));
		assert.deepEqual(stopHookDecision(fixture.payload, fixture.report), { decision: "allow" });
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a missing sidecar nudges once per conversation and then allows stop", () => {
	const fixture = setup();
	try {
		assert.deepEqual(stopHookDecision(fixture.payload, fixture.report), {
			decision: "continue",
			reason: "Call the report now: write your final report to $PI_TINYSUBAGENT_REPORT.",
		});
		assert.deepEqual(stopHookDecision(fixture.payload, fixture.report), { decision: "allow" });
		assert.equal(readFileSync(join(fixture.context, "agy-stop-conv-1.count"), "utf8"), "1");
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("malformed sidecar does not allow stop and consumes the one nudge", () => {
	const fixture = setup();
	try {
		writeFileSync(fixture.report, "not-json");
		assert.equal(stopHookDecision(fixture.payload, fixture.report).decision, "continue");
		assert.deepEqual(stopHookDecision(fixture.payload, fixture.report), { decision: "allow" });
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("agy workspace trust is added and removed without changing other settings", () => {
	const home = mkdtempSync(join(tmpdir(), "tinysubagent-home-"));
	const settingsDir = join(home, ".gemini", "antigravity-cli");
	const settings = join(settingsDir, "settings.json");
	try {
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(settings, '{\n  "colorScheme": "dark",\n  "trustedWorkspaces": ["/existing"]\n}\n');
		assert.equal(addTrustedWorkspace(home, "/run/agy"), true);
		const updated = JSON.parse(readFileSync(settings, "utf8"));
		assert.equal(updated.colorScheme, "dark");
		assert.deepEqual(updated.trustedWorkspaces, ["/existing", "/run/agy"]);
		assert.equal(addTrustedWorkspace(home, "/run/agy"), false);
		assert.equal(removeTrustedWorkspace(home, "/run/agy"), true);
		const restored = JSON.parse(readFileSync(settings, "utf8"));
		assert.deepEqual(restored.trustedWorkspaces, ["/existing"]);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("agy workspace trust creates settings if absent and rejects malformed settings", () => {
	const home = mkdtempSync(join(tmpdir(), "tinysubagent-home-"));
	try {
		assert.equal(addTrustedWorkspace(home, "/run/agy"), true);
		assert.deepEqual(JSON.parse(readFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "utf8")).trustedWorkspaces, ["/run/agy"]);
		writeFileSync(join(home, ".gemini/antigravity-cli/settings.json"), "bad json");
		assert.throws(() => addTrustedWorkspace(home, "/other"), /parse/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("conversation IDs have isolated counters", () => {
	const fixture = setup();
	try {
		assert.equal(stopHookDecision(fixture.payload, fixture.report).decision, "continue");
		assert.equal(stopHookDecision({ ...fixture.payload, conversationId: "conv-2" }, fixture.report).decision, "continue");
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
