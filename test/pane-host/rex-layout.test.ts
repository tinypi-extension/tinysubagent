/**
 * Rex orchestrator-first layout, observed at the fake-`rex` command boundary.
 *
 * No real Rex block is opened, resized or closed: every command is answered by
 * the fake CLI, and the assertions are about what the pane-host seam asked Rex
 * to do and what it returned to the caller.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPaneHost } from "../../src/pane-host/index.ts";
import { withFakeRex } from "../helpers/fake-rex.ts";

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

test("Rex layout reads normalized rects from session inspection", async () => {
	await withFakeRex({ session: birthView }, async (calls) => {
		const layout = await createPaneHost(REX_ENV).readLayout(ORCH);
		assert.deepEqual(layout, {
			tabId: "window-1",
			panes: [
				{ paneId: ORCH, rect: { x: 0, y: 0, width: 0.6, height: 1 } },
				{ paneId: FIRST, rect: { x: 0.6, y: 0, width: 0.4, height: 1 } },
			],
		});
		assert.deepEqual(calls(), ["session inspect -S server-1 sess-1 --json"]);
	});
});
