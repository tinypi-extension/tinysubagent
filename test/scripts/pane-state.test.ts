/**
 * The one reading the interrupt smoke takes from a live pane.
 *
 * The smoke needs the pane's text to know a child is mid-work before it interrupts
 * it — `waitBusy` looks for the bash call the child is running. Whether the turn
 * stopped is no longer read off the screen at all: an interrupt closes the pane,
 * and a closed pane is the proof the child is gone. So `readPane` and the flags it
 * hands herdr are what is pinned here; the status-line and footer readings are
 * gone with the "still at its prompt" check that used them.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readPane } from "../../scripts/pane-state.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run `readPane` against a stub `herdr` (never the real one), so the flags it
 * hands the CLI are pinned without a live pane. A pane id containing `fail` makes
 * the stub fail, the way an unreadable pane does.
 */
async function withHerdrStub<T>(fn: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-pane-read-"));
	const argvFile = join(dir, "argv.txt");
	const bin = join(dir, "herdr");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${shellQuote(argvFile)}`,
			'if [[ "$*" == *fail* ]]; then exit 1; fi',
			"printf 'SCREEN'",
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = bin;
	try {
		const result = await fn();
		const calls = readFileSync(argvFile, "utf8").trimEnd().split("\n");
		return { result, calls };
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("readPane", () => {
	it("reads the scrollback by default and the live screen on request", async () => {
		const { result, calls } = await withHerdrStub(async () => [
			await readPane("w1:p2"),
			await readPane("w1:p2", { visible: true }),
		]);

		assert.deepEqual(result, ["SCREEN", "SCREEN"]);
		// The scrollback is what still shows the bash call the child was running; the
		// visible screen is the screen as it stands.
		assert.deepEqual(calls, [
			"pane read w1:p2 --format text --lines 80",
			"pane read w1:p2 --format text --source visible",
		]);
	});

	it("is an empty read when herdr cannot read the pane", async () => {
		const { result } = await withHerdrStub(async () => readPane("fail:p9"));

		// A failed read is a blank screen, not a throw: the polling callers decide
		// what a pane that answers nothing means.
		assert.equal(result, "");
	});
});
