/**
 * The two readings the interrupt smoke takes from a live pane.
 *
 * The fixtures are real screens: the busy one is a pi pane running the smoke's
 * `sleep 120` task, the idle one is the same pane after an Esc stopped the turn,
 * and the third is what a pane looks like once pi is gone. The smoke's verdict —
 * "the child stopped" — rests on these, so they are pinned here rather than
 * trusted only to a live run.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { atPrompt, readPane, runningTurn } from "../../scripts/pane-state.ts";

/** A child mid-turn: the status line is drawn inside the editor's border. */
const busy = `
 $ sleep 120

 Elapsed 0.0s


── ⠸ Working ───────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/Project/tinysubagent-ip-04 (feat/ip-04-smoke-interrupt) • impl-04
↑65k ↓18k R1.0M CH97.4% $0.048 26.5%/200k (auto)  deepseek/deepseek-v4.1-flash
`;

/** The same pane after the interrupt: the status area is cleared, the editor is back. */
const stopped = `
 $ sleep 120

 Operation aborted


────────────────────────────────────────────────────────────────────────────────
~/Project/tinysubagent-ip-04 (feat/ip-04-smoke-interrupt) • impl-04
↑65k ↓18k R1.0M CH97.4% $0.048 26.5%/200k (auto)  deepseek/deepseek-v4.1-flash
`;

/** A pane whose pi is gone: a shell prompt where the editor and footer were. */
const gone = `
 $ sleep 120

 ~/Project/tinysubagent-ip-04
 $ 
`;

describe("runningTurn", () => {
	it("is true while the working status line is on screen", () => {
		assert.equal(runningTurn(busy), true);
	});

	it("is false once the interrupt cleared it", () => {
		assert.equal(runningTurn(stopped), false);
	});

	it("is false for an empty read", () => {
		assert.equal(runningTurn(""), false);
	});

	it("is true for any screen still saying Working, so a stale read fails loudly rather than passing", () => {
		assert.equal(runningTurn("Session saved\nWorking\n"), true);
	});
});

describe("atPrompt", () => {
	it("is true for a live child, busy or stopped", () => {
		assert.equal(atPrompt(busy), true);
		assert.equal(atPrompt(stopped), true);
	});

	it("is false once pi's footer is gone", () => {
		assert.equal(atPrompt(gone), false);
	});

	it("is false for an empty read", () => {
		assert.equal(atPrompt(""), false);
	});
});

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
		// The scrollback is what shows an aborted call; the visible screen is the
		// only place a running turn and a stopped one differ.
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
