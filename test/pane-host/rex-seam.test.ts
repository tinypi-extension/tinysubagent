/**
 * The Rex pane host, observed at the same command boundary as herdr.
 *
 * A fake `rex` executable records every invocation and answers selected ones
 * from fixtures. No real block is opened, renamed, inspected or closed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { detectPaneHost } from "../../src/pane-host/index.ts";

test("Rex is detected from its block and session, and herdr keeps precedence", () => {
	const env = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1" };
	assert.equal(detectPaneHost(env), "rex");
	assert.equal(detectPaneHost({ REX_SESSION: "sess-1" }), null);
	assert.equal(detectPaneHost({ REX_BLOCK: "block-1" }), null);
	assert.equal(
		detectPaneHost({
			...env,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		}),
		"herdr",
	);
});
