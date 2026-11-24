/**
 * The supervisor seam, observed from outside with a fake host CLI.
 *
 * Every spawn goes through one set of neutral operations — open, ended, stop,
 * close — and today the only kind behind them is a pane host. These tests never
 * open a real pane: they call the neutral operations and assert the command the
 * fake host received, and that the pane-only operations are reachable only
 * through the pane-host kind.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	activatePaneHost,
	createSupervisor,
	paneHostOf,
} from "../../src/pane-host/index.ts";
import { withFakeRex } from "../helpers/fake-rex.ts";

const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1", REX_SERVER: "server-1" };
const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const CHILD = "session:sess-1/block:child-full-id";
const SPLIT = "split -s sess-1 -S server-1 -b block-full-1 --split right --ratio 40 " +
	"-c /tmp/work --keep-open --label worker --focus=false --json -- bash /tmp/wrap.sh";

test("one seam opens, watches, stops and closes a child", async () => {
	const supervisor = createSupervisor(REX_ENV);
	assert.equal(supervisor.kind, "rex");
	assert.equal(supervisor.detectedIn(REX_ENV), true);
	assert.equal(supervisor.detectedIn({}), false);

	await withFakeRex(
		{
			split: JSON.stringify({ block_ids: [CHILD] }),
			block: JSON.stringify({ block_id: CHILD }),
			"send-key": "",
		},
		async (calls) => {
			const child = await supervisor.open({
				cwd: "/tmp/work",
				scriptPath: "/tmp/wrap.sh",
				label: "worker",
				pane: { targetPaneId: "block-full-1", direction: "right", focus: false },
			});
			assert.equal(child.id, CHILD);
			assert.equal(child.supervisor, supervisor);
			assert.deepEqual(calls(), [SPLIT]);

			// A child that is still there has not ended.
			assert.equal(await supervisor.ended(child), false);
			await supervisor.stop(child);
			assert.equal(await supervisor.close(child), true);
			assert.deepEqual(calls().sort(), [
				`block close -s sess-1 -S server-1 ${CHILD}`,
				`block inspect -s sess-1 -S server-1 ${CHILD} --json`,
				`send-key -s sess-1 -S server-1 -b ${CHILD} esc`,
				SPLIT,
			]);
		},
	);
});

test("a child whose pane is gone has ended", async () => {
	const supervisor = createSupervisor(REX_ENV);
	await withFakeRex({ block: { stderr: "block not found\n" } }, async (calls) => {
		const child = { supervisor, id: CHILD };
		assert.equal(await supervisor.ended(child), true);
		assert.deepEqual(calls(), [`block inspect -s sess-1 -S server-1 ${CHILD} --json`]);
	});
});

test("pane-only operations are reachable only through the pane-host kind", () => {
	const supervisor = createSupervisor(REX_ENV);
	// Absent from the neutral seam, not stubbed to throw: a caller cannot ask a
	// supervisor for a layout it may not have.
	for (const member of ["readLayout", "renameChild", "resizeChild", "relayInterrupt", "childExists"]) {
		assert.equal(member in supervisor, false, `${member} leaked into the supervision seam`);
	}

	const panes = paneHostOf(supervisor);
	assert.ok(panes, "a pane host is one kind of supervisor");
	assert.equal(panes.kind, "rex");
	assert.equal(typeof panes.renameChild, "function");
});

test("a child handle addresses the supervisor that opened it, not the active environment", async () => {
	const supervisor = createSupervisor(REX_ENV);
	await withFakeRex(
		{ split: JSON.stringify({ block_ids: [CHILD] }), block: JSON.stringify({ block_id: CHILD }) },
		async (calls) => {
			const child = await supervisor.open({
				cwd: "/tmp/work",
				scriptPath: "/tmp/wrap.sh",
				label: "worker",
				pane: { targetPaneId: "block-full-1", direction: "right", focus: false },
			});
			// The registration's environment changes under the child. Its handle still
			// names the supervisor that opened it, so the close cannot land elsewhere.
			activatePaneHost(HERDR_ENV);
			try {
				assert.equal(await child.supervisor.close(child), true);
			} finally {
				activatePaneHost({});
			}
			assert.deepEqual(calls(), [SPLIT, `block close -s sess-1 -S server-1 ${CHILD}`]);
		},
	);
});
