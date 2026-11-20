/**
 * The pane-host seam, observed from outside with a fake herdr CLI.
 *
 * These tests never open a real pane. They call the host-neutral operations
 * that the tool uses and assert the command the fake CLI received.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detectPaneHost, paneHost } from "../../src/pane-host/index.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `"'"'"`)}'`;
}

interface FakeResponse {
	stdout?: string;
	stderr?: string;
	exit?: number;
}

/**
 * A herdr binary that records every command and answers selected ones from
 * fixtures. No pane is created: the seam only sees this CLI.
 */
async function withFakeHerdr<T>(
	responses: Record<string, string | FakeResponse>,
	run: (calls: () => string[]) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-seam-"));
	const argvFile = join(dir, "argv");
	writeFileSync(argvFile, "");
	const cases: string[] = [];
	for (const [key, value] of Object.entries(responses)) {
		const response: FakeResponse = typeof value === "string" ? { stdout: value } : value;
		const file = join(dir, key.replace(/\W/g, "_"));
		writeFileSync(file, response.stdout ?? "");
		const errorFile = join(dir, `${key.replace(/\W/g, "_")}_err`);
		writeFileSync(errorFile, response.stderr ?? "");
		const emit = response.stderr
			? `cat ${shellQuote(errorFile)} 1>&2; exit ${response.exit ?? 1}`
			: `cat ${shellQuote(file)}; exit ${response.exit ?? 0}`;
		cases.push(`  "${key}") ${emit} ;;`);
	}
	const bin = join(dir, "herdr");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${shellQuote(argvFile)}`,
			'case "$1 $2" in',
			...cases,
			'  *) exit 1 ;;',
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = bin;
	const calls = (): string[] => readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean);
	try {
		return await run(calls);
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

const STATUS_READY = JSON.stringify({ id: "cli:status", result: { running: true, version: "0.8.2" } });
const PLUGIN_ON = JSON.stringify({
	id: "cli:plugin",
	result: { plugins: [{ plugin_id: "tinysubagent-panes", enabled: true }] },
});

test("pane-host detection names herdr only with a complete herdr pane context", () => {
	assert.equal(
		detectPaneHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }),
		"herdr",
	);
	assert.equal(detectPaneHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), null);
	assert.equal(detectPaneHost({}), null);
	assert.equal(paneHost.kind, "herdr");
});

test("a child opens from the wrapper script and can be renamed by the host", async () => {
	await withFakeHerdr(
		{
			"plugin pane": JSON.stringify({ id: "cli:pane", result: { plugin_pane: { pane_id: "w1:child" } } }),
			"pane rename": "{}",
		},
		async (calls) => {
			const paneId = await paneHost.openChild({
				cwd: "/tmp/work",
				targetPaneId: "w1:p1",
				direction: "right",
				scriptPath: "/tmp/wrap.sh",
				focus: false,
			});
			assert.equal(paneId, "w1:child");
			assert.equal(await paneHost.renameChild(paneId, "worker"), true);
			assert.deepEqual(calls(), [
				"plugin pane open --plugin tinysubagent-panes --entrypoint subagent --placement split " +
					"--target-pane w1:p1 --direction right --cwd /tmp/work " +
					"--env PI_HERDR_LAUNCH_SCRIPT=/tmp/wrap.sh --no-focus",
				"pane rename w1:child worker",
			]);
		},
	);
});

test("child liveness and close are host operations", async () => {
	await withFakeHerdr(
		{ "pane get": JSON.stringify({ id: "cli:pane", result: { pane: { pane_id: "w1:child" } } }) },
		async (calls) => {
			assert.equal(await paneHost.childExists("w1:child"), true);
			assert.deepEqual(calls(), ["pane get w1:child"]);
		},
	);
	await withFakeHerdr(
		{ "pane get": { stderr: '{"error":{"code":"pane_not_found"}}' } },
		async () => {
			assert.equal(await paneHost.childExists("w1:gone"), false);
		},
	);
	await withFakeHerdr({ "pane close": "{}" }, async (calls) => {
		assert.equal(await paneHost.closeChild("w1:child"), true);
		assert.deepEqual(calls(), ["pane close w1:child"]);
	});
});

test("layout read and resize use the host's geometry commands", async () => {
	const layout = JSON.stringify({
		id: "cli:pane",
		result: {
			layout: {
				tab_id: "w1",
				panes: [
					{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 120, height: 40 } },
					{ pane_id: "w1:child", rect: { x: 48, y: 0, width: 72, height: 40 } },
				],
			},
		},
	});
	await withFakeHerdr(
		{ "pane layout": layout, "pane resize": "{}" },
		async (calls) => {
			const read = await paneHost.readLayout("w1:p1");
			assert.deepEqual(
				read?.panes.map((pane) => pane.paneId),
				["w1:p1", "w1:child"],
			);
			assert.equal(
				await paneHost.resizeChild({ paneId: "w1:child", direction: "left", amount: 0.1 }),
				true,
			);
			assert.deepEqual(calls(), [
				"pane layout --pane w1:p1",
				"pane resize --direction left --amount 0.1 --pane w1:child",
			]);
		},
	);
});

test("an interrupt relays Esc to every child through the host", async () => {
	await withFakeHerdr({ "pane send-keys": "{}" }, async (calls) => {
		paneHost.relayInterrupt(["w1:a", "w1:b"]);
		for (let i = 0; i < 50 && calls().length < 2; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.deepEqual(calls().sort(), ["pane send-keys w1:a esc", "pane send-keys w1:b esc"]);
	});
});

test("host readiness comes from the pane-host CLI, not the caller", async () => {
	await withFakeHerdr(
		{ "status server": STATUS_READY, "plugin list": PLUGIN_ON },
		async (calls) => {
			const readiness = await paneHost.createCapability().probe({ timeoutMs: 5_000 });
			assert.deepEqual(readiness, { problem: null, fix: null });
			assert.deepEqual(calls(), ["status server --json", "plugin list --json"]);
		},
	);
});
