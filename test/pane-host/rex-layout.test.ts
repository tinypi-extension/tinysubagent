/**
 * Rex orchestrator-first layout, observed at the fake-`rex` command boundary.
 *
 * No real Rex block is opened, resized or closed: every command is answered by
 * the fake CLI, and the assertions are about what the pane-host seam asked Rex
 * to do and what it returned to the caller.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SpawnContext, Spawned, SpawnFailed } from "../../src/children/contract.ts";
import { spawnOne } from "../../src/children/spawn.ts";
import { activatePaneHost, createPaneHost, LiveSubPanes } from "../../src/pane-host/index.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import type { AgentDef } from "../../src/types.ts";
import { withFakeRex } from "../helpers/fake-rex.ts";

const worker: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	tools: ["read"],
	source: "user",
	path: "/tmp/worker.md",
};

const ORCH = "block-full-1";
const FIRST = "session:sess-1/block:first";
const SECOND = "session:sess-1/block:second";
const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: ORCH, REX_SERVER: "server-1" };

function view(...windows: unknown[]): string {
	return JSON.stringify({ session_id: "sess-1", windows });
}

function block(paneId: string, rect: [number, number, number, number]): unknown {
	return { block_id: paneId, rect };
}

function window(windowId: string, layout: unknown): unknown {
	return { window_id: windowId, layers: [{ kind: "tiled", layout }] };
}

const birthView = view(
	window("window-1", {
		rect: [0, 0, 1, 1],
		split: {
			split_id: "split-1",
			direction: "horizontal",
			ratio: 0.6,
			before: block(ORCH, [0, 0, 0.6, 1]),
			after: block(FIRST, [0.6, 0, 0.4, 1]),
		},
	}),
);

function spawnContext(dir: string, cwd: string, columns: LiveSubPanes): SpawnContext {
	return {
		cwd,
		agentDir: join(dir, "agent"),
		agentDirOverride: null,
		sessionDir: join(dir, "sessions"),
		sessionId: "sid",
		env: { ...REX_ENV, PI_HERDR_PI_BIN: "/usr/bin/true" },
		allToolNames: ["read", "bash"],
		agents: [worker],
		config: { enableProfiles: false, profiles: {}, env: {}, systemOne: null, classifier: null, sources: [] },
		columns,
	};
}

async function spawnWithFakeRex(
	responses: Record<string, string>,
	dir: string,
	cwd: string,
	columns: LiveSubPanes,
	name: string,
): Promise<{ spawned: Spawned | SpawnFailed; calls: string[] }> {
	return withFakeRex(responses, async (calls) => {
		activatePaneHost(REX_ENV);
		try {
			const spawned = await spawnOne(
				{ agent: "worker", task: `Do ${name}.`, name },
				spawnContext(dir, cwd, columns),
			);
			return { spawned, calls: calls() };
		} finally {
			activatePaneHost({});
		}
	});
}

async function waitForCall(calls: () => string[], needle: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (calls().some((call) => call.includes(needle))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`fake rex did not receive ${needle}`);
}

test("Rex layout reads normalized rects from session inspection", async () => {
	await withFakeRex({ session: birthView }, async (calls) => {
		const layout = await createPaneHost(REX_ENV).readLayout(ORCH);
		assert.deepEqual(layout, {
			tabId: "window-1",
			panes: [
				{ paneId: ORCH, rect: { x: 0, y: 0, width: 0.6, height: 1 } },
				{ paneId: FIRST, rect: { x: 0.6, y: 0, width: 0.4, height: 1 } },
			],
			tolerance: 1e-6,
		});
		assert.deepEqual(calls(), ["session inspect -S server-1 sess-1 --json"]);
	});
});

test("a failed Rex layout read leaves the child open and the batch reporting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-layout-fail-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd, { recursive: true });
	const columns = new LiveSubPanes();
	try {
		await withFakeRex({
			split: JSON.stringify({ block_ids: [FIRST] }),
			session: { stderr: "no such session\n", exit: 1 },
			block: JSON.stringify({ block_id: FIRST }),
		}, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const spawned = await spawnOne(
					{ agent: "worker", task: "Do it.", name: "worker" },
					spawnContext(dir, cwd, columns),
				);
				assert.equal(spawned.ok, true);
				if (!spawned.ok) return;
				writeFileSync(spawned.running.reportFile, JSON.stringify({ type: "done", result: "Still works." }));
				const results = await watchBatch([spawned.running], undefined, { watchers: new Set(), columns });
				await waitForCall(calls, "block close");
				assert.equal(results[0]?.outcome.kind, "completed");
				assert.ok(!calls().some((call) => call.startsWith("api call")));
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed Rex resize leaves the child open and the batch reporting", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-resize-fail-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd, { recursive: true });
	const columns = new LiveSubPanes();
	const halfView = view(
		window("window-1", {
			rect: [0, 0, 1, 1],
			split: {
				split_id: "root",
				direction: "horizontal",
				ratio: 0.5,
				before: block(ORCH, [0, 0, 0.5, 1]),
				after: block(FIRST, [0.5, 0, 0.5, 1]),
			},
		}),
	);
	try {
		await withFakeRex({
			split: JSON.stringify({ block_ids: [FIRST] }),
			session: halfView,
			api: { stderr: "resize rejected\n", exit: 1 },
			block: JSON.stringify({ block_id: FIRST }),
		}, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const spawned = await spawnOne(
					{ agent: "worker", task: "Do it.", name: "worker" },
					spawnContext(dir, cwd, columns),
				);
				assert.equal(spawned.ok, true);
				if (!spawned.ok) return;
				writeFileSync(spawned.running.reportFile, JSON.stringify({ type: "done", result: "Still works." }));
				const results = await watchBatch([spawned.running], undefined, { watchers: new Set(), columns });
				await waitForCall(calls, "block close");
				assert.equal(results[0]?.outcome.kind, "completed");
				assert.ok(calls().some((call) => call.startsWith("api call")));
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a two-child Rex batch births the column, appends below it and returns both reports", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-rex-layout-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd, { recursive: true });
	const columns = new LiveSubPanes();
	const halfView = view(
		window("window-1", {
			rect: [0, 0, 1, 1],
			split: {
				split_id: "root",
				direction: "horizontal",
				ratio: 0.5,
				before: block(ORCH, [0, 0, 0.5, 1]),
				after: block(FIRST, [0.5, 0, 0.5, 1]),
			},
		}),
	);
	// The operator has dragged the root border to 70/30. The later spawn must
	// rebalance only the child column, never snap this border back to 60/40.
	const appendedView = view(
		window("window-1", {
			rect: [0, 0, 1, 1],
			split: {
				split_id: "root",
				direction: "horizontal",
				ratio: 0.7,
				before: block(ORCH, [0, 0, 0.7, 1]),
				after: {
					rect: [0.7, 0, 0.3, 1],
					split: {
						split_id: "column",
						direction: "vertical",
						ratio: 0.6,
						before: block(FIRST, [0.7, 0, 0.3, 0.6]),
						after: block(SECOND, [0.7, 0.6, 0.3, 0.4]),
					},
				},
			},
		}),
	);
	try {
		const first = await spawnWithFakeRex(
			{ split: JSON.stringify({ block_ids: [FIRST] }), session: halfView, api: '{"revision":1}' },
			dir,
			cwd,
			columns,
			"first",
		);
		assert.equal(first.spawned.ok, true);
		assert.ok(first.calls.some((call) => call.includes(`--split right --ratio 40`) && call.includes(`-b ${ORCH} `)));
		assert.ok(first.calls.some((call) =>
			call.includes(`"direction":"horizontal"`) &&
			call.includes(`"before_block_id":"${ORCH}"`) &&
			call.includes(`"after_block_id":"${FIRST}"`) &&
			call.includes(`"ratio":0.6`)), first.calls.join(" | "));

		const second = await spawnWithFakeRex(
			{ split: JSON.stringify({ block_ids: [SECOND] }), session: appendedView, api: '{"revision":1}' },
			dir,
			cwd,
			columns,
			"second",
		);
		assert.equal(second.spawned.ok, true);
		assert.ok(second.calls.some((call) => call.includes(`-b ${FIRST} --split below`)));
		assert.ok(second.calls.some((call) =>
			call.includes(`"direction":"vertical"`) &&
			call.includes(`"before_block_id":"${FIRST}"`) &&
			call.includes(`"after_block_id":"${SECOND}"`) &&
			call.includes(`"ratio":0.5`)));
		assert.ok(!second.calls.some((call) => call.includes(`"direction":"horizontal"`)));

		const firstSpawned = first.spawned;
		const secondSpawned = second.spawned;
		if (!firstSpawned.ok || !secondSpawned.ok) return;
		for (const [running, text] of [
			[firstSpawned.running, "First report."],
			[secondSpawned.running, "Second report."],
		] as const) {
			writeFileSync(running.reportFile, JSON.stringify({ type: "done", result: text }));
		}
		await withFakeRex({ block: JSON.stringify({ block_id: SECOND }) }, async (calls) => {
			activatePaneHost(REX_ENV);
			try {
				const results = await watchBatch(
					[firstSpawned.running, secondSpawned.running],
					undefined,
					{ watchers: new Set(), columns },
				);
				await waitForCall(calls, "block close");
				assert.deepEqual(results.map((result) => result.paneId), [FIRST, SECOND]);
				assert.deepEqual(results.map((result) => result.outcome.kind), ["completed", "completed"]);
			} finally {
				activatePaneHost({});
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an appended Rex child rebalances its column through the vertical split ratio", async () => {
	const columnView = view(
		window("window-1", {
			rect: [0, 0, 1, 1],
			split: {
				split_id: "root",
				direction: "horizontal",
				ratio: 0.6,
				before: block(ORCH, [0, 0, 0.6, 1]),
				after: {
					rect: [0.6, 0, 0.4, 1],
					split: {
						split_id: "column",
						direction: "vertical",
						ratio: 0.6,
						before: block(FIRST, [0.6, 0, 0.4, 0.6]),
						after: block(SECOND, [0.6, 0.6, 0.4, 0.4]),
					},
				},
			},
		}),
	);
	await withFakeRex({ session: columnView, api: '{"revision":1}' }, async (calls) => {
		const resized = await createPaneHost(REX_ENV).resizeChild({
			paneId: SECOND,
			direction: "up",
			amount: 0.1,
		});
		assert.equal(resized, true);
		assert.deepEqual(calls(), [
			"session inspect -S server-1 sess-1 --json",
			`api call -s sess-1 -S server-1 session.resize_pane {"session_id":"sess-1","direction":"vertical","before_block_id":"${FIRST}","after_block_id":"${SECOND}","ratio":0.5}`,
		]);
	});
});

test("a Rex birth divider moves with a ratio resize between the two full block ids", async () => {
	const halfView = view(
		window("window-1", {
			rect: [0, 0, 1, 1],
			split: {
				split_id: "split-1",
				direction: "horizontal",
				ratio: 0.5,
				before: block(ORCH, [0, 0, 0.5, 1]),
				after: block(FIRST, [0.5, 0, 0.5, 1]),
			},
		}),
	);
	await withFakeRex({ session: halfView, api: '{"revision":1}' }, async (calls) => {
		const resized = await createPaneHost(REX_ENV).resizeChild({
			paneId: FIRST,
			direction: "right",
			amount: 0.1,
		});
		assert.equal(resized, true);
		assert.deepEqual(calls(), [
			"session inspect -S server-1 sess-1 --json",
			`api call -s sess-1 -S server-1 session.resize_pane {"session_id":"sess-1","direction":"horizontal","before_block_id":"${ORCH}","after_block_id":"${FIRST}","ratio":0.6}`,
		]);
	});
});
