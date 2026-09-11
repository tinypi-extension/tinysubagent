import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	MIN_HERDR_VERSION,
	PLUGIN_ENTRYPOINT,
	PLUGIN_ID,
	herdrPaneLayout,
	herdrPaneOpen,
	herdrPaneResize,
	herdrPluginEnable,
	herdrPluginInfo,
	herdrPluginLink,
	herdrStatus,
	pluginDir,
} from "../src/herdr.ts";
import type { TabLayout } from "../src/herdr.ts";

const manifestPath = join(pluginDir(), "herdr-plugin.toml");

// ────────────────────────────────────────────────────────────────────────────
// The shipped manifest, checked against the constants that select it
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal reader for the two shapes this manifest uses: top-level `key = value`
 * pairs and `[[panes]]` blocks. A TOML parser would be a dependency for five
 * fields, and the point of the guard is to fail loudly if the manifest and the
 * constants drift apart, not to accept arbitrary TOML.
 */
function readManifest(text: string): { top: Map<string, string>; panes: Map<string, string>[] } {
	const top = new Map<string, string>();
	const panes: Map<string, string>[] = [];
	let current: Map<string, string> | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line === "[[panes]]") {
			current = new Map<string, string>();
			panes.push(current);
			continue;
		}
		const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
		const key = match?.[1];
		const value = match?.[2];
		if (!key || !value) continue;
		(current ?? top).set(key, parseTomlValue(stripComment(value)));
	}
	return { top, panes };
}

/** Drop a trailing `#` comment that is outside a quoted string. */
function stripComment(value: string): string {
	let inString = false;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char === "\\" && inString) {
			i += 1;
			continue;
		}
		if (char === '"') inString = !inString;
		else if (char === "#" && !inString) return value.slice(0, i).trim();
	}
	return value.trim();
}

/** TOML basic strings share JSON's escaping, so a quoted scalar is JSON-parsed. */
function parseTomlValue(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed === "string") return parsed;
	}
	return value;
}

test("the shipped manifest matches the constants the extension opens it with", () => {
	const { top, panes } = readManifest(readFileSync(manifestPath, "utf8"));

	assert.equal(top.get("id"), PLUGIN_ID);
	assert.equal(top.get("min_herdr_version"), MIN_HERDR_VERSION);
	// herdr refuses a link when any required field is missing, so a renamed or
	// deleted one would otherwise only surface as a broken install.
	assert.ok(top.get("name"), "the manifest must declare name");
	assert.ok(top.get("version"), "the manifest must declare version");

	const platforms: unknown = JSON.parse(top.get("platforms") ?? "[]");
	assert.ok(Array.isArray(platforms), "platforms must be a TOML array");
	assert.ok(platforms.length > 0, "an empty platforms list is a hard link error");

	const pane = panes.find((entry) => entry.get("id") === PLUGIN_ENTRYPOINT);
	assert.ok(pane, `no pane with id "${PLUGIN_ENTRYPOINT}"`);
	assert.equal(pane.get("placement"), "split");
	assert.ok(pane.get("title"), "the manifest must declare a pane title");

	// herdr runs this argv with no shell, and `--cwd` overrides the pane's working
	// directory, so the order is load-bearing: `bash -c` wrapping an `exec bash` on
	// the path resolved from the protected plugin root. Assert it verbatim — a
	// reordered or re-quoted command still links fine and only fails at open time.
	const command: unknown = JSON.parse(pane.get("command") ?? "[]");
	assert.deepEqual(command, ["bash", "-c", 'exec bash "$HERDR_PLUGIN_ROOT/dispatch.sh"']);
});

test("pluginDir resolves to the shipped plugin with both files present", () => {
	const dir = pluginDir();
	assert.equal(existsSync(dir), true);
	assert.equal(statSync(dir).isDirectory(), true);
	assert.equal(existsSync(join(dir, "herdr-plugin.toml")), true);
	assert.equal(existsSync(join(dir, "dispatch.sh")), true);
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch.sh, the entrypoint herdr actually runs
// ────────────────────────────────────────────────────────────────────────────

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runDispatch(env: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile("bash", [join(pluginDir(), "dispatch.sh")], { env }, (error, stdout, stderr) => {
			const code = error?.code;
			// A signal-killed dispatcher reports no numeric code; that is not success.
			resolve({ code: typeof code === "number" ? code : error?.signal ? 1 : 0, stdout, stderr });
		});
	});
}

/** The ambient environment minus the handshake variable, so each case starts clean. */
function dispatchEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_HERDR_LAUNCH_SCRIPT;
	return env;
}

test("dispatch.sh names the missing variable when the handshake is absent", async () => {
	const result = await runDispatch(dispatchEnv());
	assert.equal(result.code, 64);
	assert.match(result.stderr, /PI_HERDR_LAUNCH_SCRIPT/);
	assert.match(result.stderr, /tinysubagent-panes/);
});

test("dispatch.sh refuses a launch script it cannot read", async () => {
	const missing = join(tmpdir(), "tinysubagent-does-not-exist", "launch.sh");
	const result = await runDispatch({ ...dispatchEnv(), PI_HERDR_LAUNCH_SCRIPT: missing });
	assert.equal(result.code, 66);
	assert.match(result.stderr, /not readable/);
	assert.match(result.stderr, /launch\.sh/);
});

test("dispatch.sh refuses a launch script that is a directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-dispatch-dir-"));
	try {
		const result = await runDispatch({ ...dispatchEnv(), PI_HERDR_LAUNCH_SCRIPT: dir });
		assert.equal(result.code, 66);
		assert.match(result.stderr, /directory/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dispatch.sh execs the launch script it was pointed at", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-dispatch-"));
	const script = join(dir, "launch.sh");
	writeFileSync(script, "#!/usr/bin/env bash\necho dispatch-marker\n");
	try {
		const result = await runDispatch({ ...dispatchEnv(), PI_HERDR_LAUNCH_SCRIPT: script });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /dispatch-marker/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ────────────────────────────────────────────────────────────────────────────
// The herdr calls, exercised against a stub binary
// ────────────────────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run `fn` with HERDR_BIN_PATH pointed at a stub that records its argv and
 * prints `payload`. Restores the variable and cleans up afterwards.
 */
async function withHerdrStub<T>(
	payload: string,
	fn: () => Promise<T>,
	exitCode = 0,
): Promise<{ result: T; args: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-herdr-stub-"));
	const argvFile = join(dir, "argv.txt");
	const stub = join(dir, "herdr");
	writeFileSync(
		stub,
		`#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${shellQuote(argvFile)}\nprintf '%s' ${shellQuote(payload)}\nexit ${exitCode}\n`,
	);
	chmodSync(stub, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		const result = await fn();
		const args = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trimEnd().split("\n") : [];
		return { result, args };
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Run `fn` with HERDR_BIN_PATH pointed at a stub that answers one queued
 * response per invocation — payload and exit code for call N are queue entry N.
 * The argv of each invocation is captured on its own.
 *
 * A call past the end of the queue repeats the last response instead of
 * failing: an unexpected extra call then shows up in `calls` rather than as a
 * mystifying missing-payload error.
 */
async function withHerdrStubScript<T>(
	responses: { payload: string; exitCode?: number }[],
	fn: () => Promise<T>,
): Promise<{ result: T; calls: string[][] }> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-herdr-script-"));
	const counterFile = join(dir, "count");
	const stub = join(dir, "herdr");
	const payloads = responses.map((entry) => shellQuote(entry.payload)).join(" ");
	const codes = responses.map((entry) => String(entry.exitCode ?? 0)).join(" ");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			`dir=${shellQuote(dir)}`,
			`payloads=(${payloads})`,
			`codes=(${codes})`,
			`count=$(cat "$dir/count" 2>/dev/null || echo 0)`,
			`printf '%s\\n' "$@" > "$dir/argv-$count.txt"`,
			`printf '%s' "$((count + 1))" > "$dir/count"`,
			`n=\${#payloads[@]}`,
			'if [ "$n" -eq 0 ]; then exit 0; fi',
			"idx=$count",
			'if [ "$idx" -ge "$n" ]; then idx=$((n - 1)); fi',
			`printf '%s' "\${payloads[$idx]}"`,
			`exit "\${codes[$idx]}"`,
		].join("\n") + "\n",
	);
	chmodSync(stub, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		const result = await fn();
		const count = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8").trim()) || 0 : 0;
		const calls: string[][] = [];
		for (let i = 0; i < count; i += 1) {
			const file = join(dir, `argv-${i}.txt`);
			if (!existsSync(file)) continue;
			const text = readFileSync(file, "utf8");
			calls.push(text === "" ? [] : text.replace(/\n$/, "").split("\n"));
		}
		return { result, calls };
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("withHerdrStubScript answers one queued response per call and records argv per call", async () => {
	const statusPayload = JSON.stringify({ id: "cli:status", result: { running: true, version: "1.1.1" } });
	const pluginPayload = JSON.stringify({
		id: "cli:plugin",
		result: { plugins: [{ plugin_id: PLUGIN_ID, enabled: true }] },
	});
	const { result, calls } = await withHerdrStubScript(
		[{ payload: statusPayload }, { payload: pluginPayload }],
		async () => ({
			status: await herdrStatus(),
			plugin: await herdrPluginInfo(),
		}),
	);

	// Two invocations, two argv sets, each captured on its own.
	assert.deepEqual(calls, [
		["status", "server", "--json"],
		["plugin", "list", "--json"],
	]);
	// The second call saw the second payload, so the queue is consumed in order.
	assert.deepEqual(result.status, { running: true, version: "1.1.1" });
	assert.deepEqual(result.plugin, { id: PLUGIN_ID, enabled: true });
});

test("withHerdrStubScript honours per-call exit codes and repeats the last response", async () => {
	const { result, calls } = await withHerdrStubScript(
		[
			{ payload: JSON.stringify({ id: "cli:status", result: { running: true, version: "1.0.0" } }) },
			{ payload: "", exitCode: 7 },
		],
		async () => [await herdrStatus(), await herdrStatus(), await herdrStatus()],
	);

	assert.equal(result[0]?.version, "1.0.0");
	assert.equal(result[1], null);
	// Call three is past the queue, so it repeats call two's non-zero response.
	assert.equal(result[2], null);
	assert.equal(calls.length, 3);
});

test("herdrPaneOpen passes plugin, target, cwd, env and focus in that order", async () => {
	const envelope = '{"id":"cli:plugin","result":{"plugin_pane":{"pane":{"pane_id":"pane-123"}}}}';
	const { result, args } = await withHerdrStub(envelope, () =>
		herdrPaneOpen({
			cwd: "/some/cwd",
			targetPaneId: "pane-target",
			direction: "right",
			env: { PI_HERDR_LAUNCH_SCRIPT: "/tmp/launch.sh" },
			focus: false,
		}),
	);

	assert.equal(result, "pane-123");
	assert.deepEqual(args, [
		"plugin",
		"pane",
		"open",
		"--plugin",
		PLUGIN_ID,
		"--entrypoint",
		PLUGIN_ENTRYPOINT,
		"--placement",
		"split",
		"--target-pane",
		"pane-target",
		"--direction",
		"right",
		"--cwd",
		"/some/cwd",
		"--env",
		"PI_HERDR_LAUNCH_SCRIPT=/tmp/launch.sh",
		"--no-focus",
	]);
});

test("herdrPluginInfo reads enabled, disabled and absent from the plugin list", async () => {
	const enabled = await withHerdrStub(
		JSON.stringify({ id: "cli:plugin", result: { plugins: [{ plugin_id: PLUGIN_ID, enabled: true }] } }),
		() => herdrPluginInfo(PLUGIN_ID),
	);
	assert.deepEqual(enabled.result, { id: PLUGIN_ID, enabled: true });

	const disabled = await withHerdrStub(
		JSON.stringify({ id: "cli:plugin", result: { plugins: [{ id: PLUGIN_ID, enabled: false }] } }),
		() => herdrPluginInfo(PLUGIN_ID),
	);
	assert.deepEqual(disabled.result, { id: PLUGIN_ID, enabled: false });

	const absent = await withHerdrStub(
		JSON.stringify({ id: "cli:plugin", result: { plugins: [{ plugin_id: "something-else", enabled: true }] } }),
		() => herdrPluginInfo(PLUGIN_ID),
	);
	assert.equal(absent.result, null);
});

test("herdrPluginLink links the given path with --enabled", async () => {
	const envelope = '{"id":"cli:plugin","result":{"type":"plugin_linked"}}';
	const { result, args } = await withHerdrStub(envelope, () => herdrPluginLink("/some/plugin-dir"));
	assert.equal(result, undefined);
	// `--enabled` is part of the same step so a confirm cannot leave a plugin
	// linked-but-off, which would need a second prompt to fix.
	assert.deepEqual(args, ["plugin", "link", "/some/plugin-dir", "--enabled"]);
});

test("herdrPluginEnable enables the bundled plugin by id", async () => {
	const envelope = '{"id":"cli:plugin","result":{"type":"plugin_enabled"}}';
	const { args } = await withHerdrStub(envelope, () => herdrPluginEnable());
	assert.deepEqual(args, ["plugin", "enable", PLUGIN_ID]);
});

test("a failing plugin command surfaces herdr's exit status", async () => {
	// The session hook promises the user nothing on failure, so the command must
	// reject rather than return quietly and let the tool probe disagree.
	await withHerdrStub("", () => assert.rejects(herdrPluginLink("/nope")), 1);
});

test("herdrPaneOpen refuses a pane it cannot address", async () => {
	const envelope = '{"id":"cli:plugin","result":{"plugin_pane":{"pane":{}}}}';
	await withHerdrStub(envelope, async () => {
		await assert.rejects(herdrPaneOpen({ cwd: "/some/cwd" }), /reported no id/);
	});
});

test("herdrPaneLayout runs pane layout for the pane and unwraps the tab", async () => {
	const envelope = JSON.stringify({
		id: "cli:pane",
		result: {
			layout: {
				tab_id: "tab-1",
				panes: [
					{ pane_id: "pane-a", rect: { x: 0, y: 0, width: 127, height: 58 } },
					{ pane_id: "pane-b", rect: { x: 127, y: 0, width: 84, height: 58 } },
				],
			},
		},
	});
	const { result, args } = await withHerdrStub(envelope, () => herdrPaneLayout("pane-root"));

	assert.deepEqual(args, ["pane", "layout", "--pane", "pane-root"]);
	assert.deepEqual(result, {
		tabId: "tab-1",
		panes: [
			{ paneId: "pane-a", rect: { x: 0, y: 0, width: 127, height: 58 } },
			{ paneId: "pane-b", rect: { x: 127, y: 0, width: 84, height: 58 } },
		],
	} satisfies TabLayout);
});

test("herdrPaneLayout returns null when the call, the JSON or the layout is unusable", async () => {
	const missingLayout = await withHerdrStub(
		JSON.stringify({ id: "cli:pane", result: { type: "something_else" } }),
		() => herdrPaneLayout("pane-1"),
	);
	assert.equal(missingLayout.result, null);

	const nonJson = await withHerdrStub("not json", () => herdrPaneLayout("pane-1"));
	assert.equal(nonJson.result, null);

	const failed = await withHerdrStub("", () => herdrPaneLayout("pane-1"), 1);
	assert.equal(failed.result, null);

	const panesNotAnArray = await withHerdrStub(
		JSON.stringify({ id: "cli:pane", result: { layout: { tab_id: "tab-1", panes: "nope" } } }),
		() => herdrPaneLayout("pane-1"),
	);
	assert.equal(panesNotAnArray.result, null);
});

test("herdrPaneLayout drops pane entries it cannot address or measure", async () => {
	const envelope = JSON.stringify({
		id: "cli:pane",
		result: {
			layout: {
				tab_id: 42,
				panes: [
					{ pane_id: "keep", rect: { x: 1, y: 2, width: 3, height: 4 } },
					{ rect: { x: 0, y: 0, width: 1, height: 1 } },
					{ pane_id: 7, rect: { x: 0, y: 0, width: 1, height: 1 } },
					{ pane_id: "no-rect" },
					{ pane_id: "bad-rect", rect: { x: 0, y: 0, width: "3", height: 4 } },
				],
			},
		},
	});
	const { result } = await withHerdrStub(envelope, () => herdrPaneLayout("pane-1"));

	// A non-string tab id is not addressable; the bad pane entries are dropped
	// rather than poisoning the whole layout.
	assert.deepEqual(result, {
		tabId: null,
		panes: [{ paneId: "keep", rect: { x: 1, y: 2, width: 3, height: 4 } }],
	});
});

test("herdrPaneResize moves the divider with the pinned argv", async () => {
	const { result, args } = await withHerdrStub('{"id":"cli:pane","result":{"ok":true}}', () =>
		herdrPaneResize("pane-b", "up", 0.5),
	);

	assert.equal(result, true);
	assert.deepEqual(args, ["pane", "resize", "--direction", "up", "--amount", "0.5", "--pane", "pane-b"]);
});

test("herdrPaneResize reports failure instead of throwing", async () => {
	const { result } = await withHerdrStub("", () => herdrPaneResize("pane-b", "left", 0.25), 1);
	assert.equal(result, false);
});
