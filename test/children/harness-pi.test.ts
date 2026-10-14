import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildPiArgv, resolvePiBin } from "../../src/children/launch.ts";
import { piHarness } from "../../src/children/harness/pi.ts";
import { harnessFor } from "../../src/children/harness/index.ts";
import { agyHarness } from "../../src/children/harness/agy.ts";

function tempFile(name: string, content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "tinysubagent-harness-"));
	const file = path.join(dir, name);
	writeFileSync(file, content);
	return file;
}

test("the pi adapter reports its identity and extension support", () => {
	assert.equal(piHarness.id, "pi");
	assert.equal(piHarness.supportsExtension, true);
});

test("the pi adapter resolves the same bin override as launch-script", () => {
	assert.equal(piHarness.resolveBin({ PI_HERDR_PI_BIN: "/opt/pi" }), "/opt/pi");
	assert.equal(piHarness.resolveBin({}), "pi");
});

test("the pi adapter builds the same argv as the launch-script delegate", () => {
	const spec = {
		bin: "pi",
		childSessionFile: "/s.jsonl",
		childExtensionPath: "/child.ts",
		name: "worker",
		model: "oc-openai/deepseek-flash",
		thinking: "low",
		tools: ["read", "bash"],
		taskFile: "/t.md",
	};
	assert.deepEqual(piHarness.buildArgv(spec), buildPiArgv({ ...spec, piBin: "pi" }));
});

test("readTurn returns the last assistant text from a session file", () => {
	const user = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } });
	const assistant = JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
	});
	const file = tempFile("session.jsonl", `${user}\n${assistant}\n`);
	assert.deepEqual(piHarness.readTurn(file), { text: "the answer" });
});

test("readTurn yields a null text for a session with no assistant message", () => {
	const file = tempFile("session.jsonl", `${JSON.stringify({ type: "message", message: { role: "user" } })}\n`);
	assert.deepEqual(piHarness.readTurn(file), { text: null });
});

test("readTurn yields a null text for an unreadable session file", () => {
	assert.deepEqual(piHarness.readTurn(path.join(tmpdir(), "tinysubagent-nope.jsonl")), {
		text: null,
	});
});

test("sessionFileFor lands in the cwd-mirrored sessions dir with a jsonl name", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "tinysubagent-agentdir-"));
	const file = piHarness.sessionFileFor("/some/cwd", dir);
	const expectedDir = path.join(
		dir,
		"sessions",
		`--${"/some/cwd".replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
	);
	assert.ok(file.startsWith(`${expectedDir}${path.sep}`), file);
	assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/);
});

test("agy adapter resolves its override and default binary", () => {
	assert.equal(agyHarness.resolveBin({ TINYSUBAGENT_AGY_BIN: "/opt/agy" }), "/opt/agy");
	assert.equal(agyHarness.resolveBin({}), "agy");
});

test("agy adapter maps the shared thinking levels to effort, never print mode", () => {
	assert.deepEqual(agyHarness.buildArgv({
		bin: "/opt/agy",
		childSessionFile: "/unused.jsonl",
		childExtensionPath: "/unused.ts",
		model: "gpt-oss-120b-medium",
		thinking: "medium",
		taskFile: "/task.md",
	}), ["/opt/agy", "--model", "gpt-oss-120b-medium", "--effort", "medium", "-i", "@/task.md"]);
	for (const [thinking, effort] of [["off", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["max", "high"]]) {
		const argv = agyHarness.buildArgv({
			bin: "agy", childSessionFile: "", childExtensionPath: "", model: "model", thinking, taskFile: "/task.md",
		});
		assert.deepEqual(argv.slice(3, 5), ["--effort", effort], thinking);
		assert.equal(argv.includes("-p"), false);
	}
	const noLevel = agyHarness.buildArgv({
		bin: "agy", childSessionFile: "", childExtensionPath: "", model: "model", taskFile: "/task.md",
	});
	assert.deepEqual(noLevel, ["agy", "--model", "model", "-i", "@/task.md"]);
});

test("agy is report-only and does not use the pi extension", async () => {
	assert.equal(agyHarness.supportsExtension, false);
	assert.equal(agyHarness.sessionFileFor("/cwd", "/agent"), "");
	assert.equal(agyHarness.readTurn("/transcript"), null);
	assert.equal(await agyHarness.readRefusal({} as never), null);
});

test("harnessFor resolves agy and pi for their respective profiles", () => {
	assert.equal(harnessFor({}), piHarness);
	assert.equal(harnessFor({ harness: "pi" }), piHarness);
	assert.equal(harnessFor({ harness: "agy" }), agyHarness);
});
