/**
 * Outcome parity at the Rex pane-host seam: only a completion that means the
 * child is gone closes its block. A turn-end completion, a failure, and a pane
 * that vanished leave the block on screen; none of them hangs the batch.
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
const TURN_END = "session:sess-1/block:turn-end";
const FAILED = "session:sess-1/block:failed";
const VANISHED = "session:sess-1/block:vanished";

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
		sessionEntriesAtLaunch: 0,
		exitCodeFile: `${sessionFile}.exitcode`,
		reportFile: `${sessionFile}.done`,
		startedAt: Date.now(),
		task: `task ${name}`,
	};
}

async function quiet(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

test("turn-end and failed Rex children leave their blocks open", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-outcomes-"));
	try {
		await withFakeRex({ block: JSON.stringify({ block_id: TURN_END }) }, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const turnEnd = running(dir, "turn", TURN_END);
				const failed = running(dir, "failed", FAILED);
				writeFileSync(turnEnd.reportFile, '{"type":"done"}');
				writeFileSync(failed.reportFile, '{"type":"failed","reason":"error"}');

				const columns = new LiveSubPanes();
				columns.place(TURN_END);
				columns.place(FAILED);
				const results = await watchBatch([turnEnd, failed], undefined, {
					watchers: new Set(),
					columns,
				});
				await quiet();

				assert.deepEqual(
					results.map((result) => result.outcome),
					[
						{ kind: "completed", via: "turn-end", summary: null },
						{ kind: "failed", reason: "error", exitCode: null, summary: null },
					],
				);
				assert.deepEqual(calls(), []);
				assert.deepEqual(columns.trackedIds(), [TURN_END, FAILED]);
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a vanished Rex block cancels its child without closing it or hanging the batch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-vanished-"));
	try {
		await withFakeRex({ block: { stderr: "block not found\n" } }, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const child = running(dir, "vanished", VANISHED);
				const columns = new LiveSubPanes();
				columns.place(VANISHED);
				const startedAt = Date.now();
				const results = await watchBatch([child], undefined, {
					watchers: new Set(),
					columns,
				});
				const elapsedMs = Date.now() - startedAt;
				await quiet();

				assert.equal(results.length, 1);
				assert.deepEqual(results[0]?.outcome, { kind: "cancelled", summary: null });
				assert.ok(elapsedMs < 10_000, `cancelled wait took ${elapsedMs}ms`);
				assert.deepEqual(calls(), [`block inspect -s sess-1 -S server-1 ${VANISHED} --json`]);
				assert.deepEqual(columns.trackedIds(), [VANISHED]);
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
