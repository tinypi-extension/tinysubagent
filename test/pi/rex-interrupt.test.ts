/**
 * Interrupt parity at the Rex pane-host seam: an operator's Esc reaches every
 * tracked child by its full block ID, and only the waits it stops are closed.
 * Shutdown is the opposite path — child controllers are aborted directly, with
 * no relay and no closes.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunningSubagent } from "../../src/children/watcher.ts";
import { activatePaneHost, LiveSubPanes } from "../../src/pane-host/index.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import { withFakeRex } from "../helpers/fake-rex.ts";

const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1", REX_SERVER: "server-1" };
const FIRST = "session:sess-1/block:child-a";
const SECOND = "session:sess-1/block:child-b";

/** A child with no sidecars: it can only end through one of the two aborts. */
function running(dir: string, name: string, paneId: string): RunningSubagent {
	const sessionFile = join(dir, `${name}.jsonl`);
	writeFileSync(sessionFile, "", "utf8");
	return {
		id: `${name}-id`,
		name,
		agent: null,
		profile: null,
		paneId,
		writesSession: false,
		sessionFile,
		exitCodeFile: `${sessionFile}.exitcode`,
		reportFile: `${sessionFile}.done`,
		startedAt: Date.now(),
		task: `task ${name}`,
	};
}

async function waitForCalls(calls: () => string[], needles: readonly string[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const seen = calls();
		if (needles.every((needle) => seen.includes(needle))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`missing rex calls: ${needles.join(" | ")} — saw ${calls().join(" | ")}`);
}

/** Let any stray fire-and-forget command land before checking what did not happen. */
async function quiet(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

test("an interrupt Esc reaches both Rex children by full id and closes both blocks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-interrupt-"));
	try {
		await withFakeRex(
			{
				// Hold each Esc in flight so a close issued before the relay resolves
				// would appear first in the log and fail the order check below.
				"send-key": { stdout: "", delayMs: 150 },
				block: JSON.stringify({ block_id: FIRST }),
			},
			async (calls) => {
				activatePaneHost(REX_ENV);
				try {
					const columns = new LiveSubPanes();
					columns.place(FIRST);
					columns.place(SECOND);
					const signal = new AbortController();
					const batch = watchBatch(
						[running(dir, "a", FIRST), running(dir, "b", SECOND)],
						signal.signal,
						{ watchers: new Set(), columns },
					);
					signal.abort();
					const results = await batch;

					const esc = [
						`send-key -s sess-1 -S server-1 -b ${FIRST} esc`,
						`send-key -s sess-1 -S server-1 -b ${SECOND} esc`,
					];
					const close = [
						`block close -s sess-1 -S server-1 ${FIRST}`,
						`block close -s sess-1 -S server-1 ${SECOND}`,
					];
					await waitForCalls(calls, [...esc, ...close]);

					// The relay is awaited before any close is issued, so the log cannot
					// show a block disappearing while its Esc is still in flight.
					const order = calls();
					const lastEsc = order.reduce(
						(last, call, index) => (call.startsWith("send-key") ? index : last),
						-1,
					);
					const firstClose = order.findIndex((call) => call.startsWith("block close"));
					assert.ok(
						firstClose === -1 || lastEsc < firstClose,
						`Esc was not sent before a close: ${order.join(" | ")}`,
					);

					assert.deepEqual(
						results.map((result) => result.outcome),
						[
							{ kind: "interrupted", cause: "interrupt" },
							{ kind: "interrupted", cause: "interrupt" },
						],
					);
					assert.deepEqual(calls().filter((call) => call.startsWith("send-key")).sort(), esc);
					assert.deepEqual(calls().filter((call) => call.startsWith("block close")).sort(), close);
					assert.deepEqual(columns.trackedIds(), []);
				} finally {
					activatePaneHost({});
				}
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a shutdown under a Rex wait ends the children as interrupted and leaves their blocks open", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-shutdown-"));
	try {
		await withFakeRex({ block: JSON.stringify({ block_id: FIRST }) }, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const columns = new LiveSubPanes();
				columns.place(FIRST);
				columns.place(SECOND);
				const watchers = new Set<AbortController>();
				const batch = watchBatch(
					[running(dir, "a", FIRST), running(dir, "b", SECOND)],
					undefined,
					{ watchers, columns },
				);
				for (const watcher of watchers) watcher.abort("shutdown");
				const results = await batch;
				await quiet();

				assert.deepEqual(
					results.map((result) => result.outcome),
					[
						{ kind: "interrupted", cause: "shutdown" },
						{ kind: "interrupted", cause: "shutdown" },
					],
				);
				assert.deepEqual(calls(), []);
				assert.deepEqual(columns.trackedIds(), [FIRST, SECOND]);
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
