/**
 * One Rex child, end to end: the wrapper is split off the orchestrator's
 * block, its sidecars settle the wait, and the block closes. Only the CLI
 * boundary is faked.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnOne } from "../../src/children/spawn.ts";
import type { SpawnContext } from "../../src/children/contract.ts";
import { activatePaneHost, LiveSubPanes } from "../../src/pane-host/index.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import { buildResultText, type SubagentResult } from "../../src/present/result.ts";
import type { AgentDef } from "../../src/types.ts";
import { withFakeRex } from "../helpers/fake-rex.ts";

const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1", REX_SERVER: "server-1" };
const CHILD = "session:sess-1/block:child-full-id";

const worker: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	tools: ["read"],
	source: "user",
	path: "/tmp/worker.md",
};

function context(dir: string, cwd: string): SpawnContext {
	return {
		cwd,
		agentDir: join(dir, "agent"),
		agentDirOverride: null,
		sessionDir: join(dir, "sessions"),
		sessionId: "sid",
		env: { PI_HERDR_PI_BIN: "/usr/bin/true" },
		allToolNames: ["read", "bash"],
		agents: [worker],
		config: { enableProfiles: false, profiles: {}, env: {}, systemOne: null, classifier: null, sources: [] },
	};
}

async function waitForCall(calls: () => string[], needle: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (calls().some((call) => call.includes(needle))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`rex did not receive a call containing ${needle}: ${calls().join(" | ")}`);
}

/** Spawn one Rex child, publish a sidecar, wait, and return the tool result. */
async function runRexBatch(
	dir: string,
	cwd: string,
	settle: (running: { exitCodeFile: string; reportFile: string; id: string }) => void,
): Promise<{ results: SubagentResult[]; calls: string[] }> {
	return withFakeRex(
		{
			split: JSON.stringify({ block_ids: [CHILD] }),
			block: JSON.stringify({ block_id: CHILD }),
		},
		async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const spawned = await spawnOne(
					{ agent: "worker", task: "Do it.", name: "worker" },
					context(dir, cwd),
				);
				assert.equal(spawned.ok, true);
				if (!spawned.ok) return { results: [], calls: calls() };
				settle(spawned.running);
				const results = await watchBatch([spawned.running], undefined, {
					watchers: new Set(),
					columns: new LiveSubPanes(),
				});
				await waitForCall(calls, "block close");
				return { results, calls: calls() };
			} finally {
				activatePaneHost({});
			}
		},
	);
}

function tempWorkdir(): { dir: string; cwd: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-batch-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd, { recursive: true });
	return { dir, cwd, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one Rex child returns its report and closes its block", async () => {
	const { dir, cwd, cleanup } = tempWorkdir();
	try {
		const { results, calls } = await runRexBatch(dir, cwd, (running) => {
			writeFileSync(running.reportFile, JSON.stringify({ type: "done", result: "Rex child finished." }));
		});
		assert.equal(results.length, 1);
		assert.equal(results[0]?.paneId, CHILD);
		assert.equal(results[0]?.outcome.kind, "completed");
		assert.equal(results[0]?.outcome.via, "report");
		assert.match(buildResultText(results), /Rex child finished\./);

		const splitCall = calls.find((call) => call.startsWith("split ")) ?? "";
		assert.match(splitCall, /--label worker/);
		assert.match(splitCall, new RegExp(`-- .*subagent-scripts/worker-[a-f0-9]+\\.sh$`));
		assert.ok(calls.includes(`block close -s sess-1 -S server-1 ${CHILD}`));
	} finally {
		cleanup();
	}
});

test("a clean session exit closes the Rex block too", async () => {
	const { dir, cwd, cleanup } = tempWorkdir();
	try {
		const { results } = await runRexBatch(dir, cwd, (running) => {
			writeFileSync(running.exitCodeFile, `0 ${running.id}`);
		});
		assert.equal(results[0]?.outcome.kind, "completed");
		assert.equal(results[0]?.outcome.via, "session-exit");
	} finally {
		cleanup();
	}
});
