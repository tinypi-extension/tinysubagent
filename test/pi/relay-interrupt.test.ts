import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createInterruptRelay } from "../../src/pi/relay-interrupt.ts";

/**
 * A herdr binary that only records what it was asked to do. `pane send-keys`
 * for a pane listed in `gone` fails the way a pane that has already closed does.
 */
async function withEscStub<T>(fn: (calls: () => string[]) => Promise<T>, gone: readonly string[] = []): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-relay-"));
	const stub = join(dir, "herdr");
	const log = `${stub}.log`;
	const gonePattern = ["", ...gone, ""].join(" ");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> '${log}'`,
			'"$1 $2" == "pane send-keys" || exit 0',
			`case ' ${gonePattern} ' in`,
			`  *" $3 "*) printf '%s' '{"error":{"code":"pane_not_found"}}' >&2; exit 1 ;;`,
			"esac",
			"printf '%s' '{\"id\":\"cli:pane\",\"result\":{\"ok\":true}}'",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);

	const calls = (): string[] => {
		try {
			return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
		} catch {
			return [];
		}
	};

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		return await fn(calls);
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Poll until `check` passes, so a slow exec is waited for rather than slept on. */
async function until(
	check: () => Promise<boolean>,
	what: string,
	timeoutMs = 4_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(what);
}

/**
 * Wait until the relay's fire-and-forget sends have all landed: the command log
 * must stay unchanged for a quiet window before the test reads it. A fixed sleep
 * would be either flaky or slow, since a cold `execFile` takes a while.
 */
async function quiet(calls: () => string[], timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let seen = -1;
	while (Date.now() < deadline) {
		const now = calls().length;
		if (now === seen) return;
		seen = now;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("the herdr command log never stopped changing");
}

test("relaying an interrupt types one Esc into a live pane", async () => {
	await withEscStub(async (calls) => {
		createInterruptRelay().relayOne("w1:p1Z");
		await until(async () => calls().length >= 1, "the Esc never reached herdr");
		await quiet(calls);
		assert.deepEqual(calls(), ["pane send-keys w1:p1Z esc"]);
	});
});

test("a pane is relayed to once, however often it is asked for", async () => {
	await withEscStub(async (calls) => {
		const relay = createInterruptRelay();
		relay.relayAll(["w1:p1Z", "w1:p2Z"]);
		relay.relayOne("w1:p1Z");
		relay.relayAll(["w1:p2Z"]);
		await until(async () => calls().length >= 2, "the fan-out never reached herdr");
		await quiet(calls);
		assert.deepEqual(calls().sort(), ["pane send-keys w1:p1Z esc", "pane send-keys w1:p2Z esc"]);
	});
});

test("a pane that is already gone is silent, and the rest of the fan-out still goes out", async () => {
	await withEscStub(
		async (calls) => {
			const relay = createInterruptRelay();
			// Neither call may throw: the relay runs off an abort listener, where a
			// rejection would surface as an unhandled one.
			relay.relayAll(["w1:p1Z", "w1:p2Z"]);
			relay.relayOne("w1:p3Z");
			await until(async () => calls().length >= 3, "the fan-out never reached herdr");
			await quiet(calls);
			// Concurrent execs land in whatever order the OS starts them, so compare
			// as a set: what matters is that the two live panes were not skipped.
			assert.deepEqual(calls().sort(), [
				"pane send-keys w1:p1Z esc",
				"pane send-keys w1:p2Z esc",
				"pane send-keys w1:p3Z esc",
			]);
		},
		["w1:p1Z", "w1:p3Z"],
	);
});
