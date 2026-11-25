/**
 * The wait and the batch end through the supervisor a child carries.
 *
 * A running child owns a handle: the supervisor that opened it plus its address
 * there. Liveness and the completion close are asked of that supervisor, never
 * of whatever environment the process happens to have active.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { waitForSubagent, type RunningSubagent } from "../../src/children/watcher.ts";
import { LiveSubPanes, type Supervisor, type SupervisorHandle } from "../../src/pane-host/index.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";

/** A supervisor that records what it was asked, and speaks no host CLI. */
function recorder(): {
	supervisor: Supervisor;
	ended: SupervisorHandle[];
	stopped: SupervisorHandle[];
	closed: SupervisorHandle[];
} {
	const ended: SupervisorHandle[] = [];
	const stopped: SupervisorHandle[] = [];
	const closed: SupervisorHandle[] = [];
	const supervisor: Supervisor = {
		kind: "rex",
		detectedIn: () => true,
		createCapability: () => ({
			ensureReady: async () => null,
			probe: async () => ({ problem: null, fix: null }),
			reset: () => {},
		}),
		open: async () => assert.fail("a finished child is never reopened"),
		ended: async (child) => {
			ended.push(child);
			return false;
		},
		stop: async (child) => {
			stopped.push(child);
		},
		close: async (child) => {
			closed.push(child);
			return true;
		},
	};
	return { supervisor, ended, stopped, closed };
}

function running(dir: string, child: SupervisorHandle | undefined, paneId: string): RunningSubagent {
	const sessionFile = join(dir, "worker.jsonl");
	writeFileSync(sessionFile, "", "utf8");
	return {
		id: "worker-id",
		name: "worker",
		agent: null,
		profile: null,
		paneId,
		child,
		writesSession: false,
		sessionFile,
		exitCodeFile: `${sessionFile}.exitcode`,
		reportFile: `${sessionFile}.done`,
		startedAt: Date.now(),
		task: "task worker",
	};
}

test("a wait asks the child's own supervisor whether it has ended", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-supervisor-wait-"));
	try {
		const { supervisor, ended } = recorder();
		const child: SupervisorHandle = { supervisor, id: "child-address" };
		const record = running(dir, child, "child-address");
		record.reportFile = join(dir, "absent.done");
		// The pane is gone as far as this child's supervisor is concerned, and no
		// bare pane id is ever handed to a host: the recorder is the only channel.
		supervisor.ended = async (handle) => {
			ended.push(handle);
			return true;
		};

		const outcome = await waitForSubagent(record, undefined, { pollIntervalMs: 5 });

		assert.equal(outcome.kind, "cancelled");
		assert.deepEqual(ended.map((handle) => handle.id), ["child-address"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a completed child is closed through the child's own supervisor", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-supervisor-batch-"));
	try {
		const { supervisor, stopped, closed } = recorder();
		const child: SupervisorHandle = { supervisor, id: "child-address" };
		const record = running(dir, child, "child-address");
		writeFileSync(record.reportFile, '{"type":"done","result":"all done"}');

		const columns = new LiveSubPanes();
		columns.place("child-address");
		const results = await watchBatch([record], undefined, { watchers: new Set(), columns });

		assert.deepEqual(results.map((result) => result.outcome.kind), ["completed"]);
		assert.deepEqual(closed.map((handle) => handle.id), ["child-address"]);
		assert.deepEqual(stopped, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
