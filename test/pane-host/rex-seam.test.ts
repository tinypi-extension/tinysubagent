/**
 * The Rex pane host, observed at the same command boundary as herdr.
 *
 * A fake `rex` executable records every invocation and answers selected ones
 * from fixtures. No real block is opened, renamed, inspected or closed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createPaneHost, detectPaneHost } from "../../src/pane-host/index.ts";
import { withFakeRex, withoutRex } from "../helpers/fake-rex.ts";

const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1" };

test("Rex is detected from its block and session, and herdr keeps precedence", () => {
	assert.equal(detectPaneHost(REX_ENV), "rex");
	assert.equal(detectPaneHost({ REX_SESSION: "sess-1" }), null);
	assert.equal(detectPaneHost({ REX_BLOCK: "block-1" }), null);
	assert.equal(
		detectPaneHost({
			...REX_ENV,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		}),
		"herdr",
	);
});

test("a child block opens from the wrapper through bash, with a label and a full split ID", async () => {
	const split = JSON.stringify({ block_ids: ["session:sess-1/block:child-full-id"] });
	await withFakeRex({ split }, async (calls) => {
		const paneId = await createPaneHost({ ...REX_ENV, REX_SERVER: "server-1" }).openChild({
			cwd: "/tmp/work",
			targetPaneId: null,
			direction: "right",
			scriptPath: "/tmp/wrap.sh",
			focus: false,
			label: "worker",
		});
		assert.equal(paneId, "session:sess-1/block:child-full-id");
		// Rex runs COMMAND through the login shell, so a bare path would need +x.
		// Generated launchers are intentionally 0644; name bash explicitly.
		assert.deepEqual(calls(), [
			"split -s sess-1 -S server-1 -b block-full-1 --split right --ratio 40 " +
				"-c /tmp/work --keep-open --label worker --focus=false --json -- bash /tmp/wrap.sh",
		]);
	});
});

test("Rex liveness, rename and close use pinned block commands", async () => {
	const child = "session:sess-1/block:child-full-id";
	const host = createPaneHost({ ...REX_ENV, REX_SERVER: "server-1" });
	await withFakeRex({ block: JSON.stringify({ block_id: child }) }, async (calls) => {
		assert.equal(await host.childExists(child), true);
		assert.equal(await host.renameChild(child, "finder"), true);
		assert.equal(await host.closeChild(child), true);
		assert.deepEqual(calls(), [
			`block inspect -s sess-1 -S server-1 ${child} --json`,
			`block rename -s sess-1 -S server-1 ${child} finder`,
			`block close -s sess-1 -S server-1 ${child}`,
		]);
	});

	await withFakeRex({ block: { stderr: "block not found\n" } }, async () => {
		assert.equal(await host.childExists(child), false);
	});
});

test("an interrupt sends Esc to every live block by full id, pinned to the session", async () => {
	const first = "session:sess-1/block:child-a";
	const second = "session:sess-1/block:child-b";
	const host = createPaneHost({ ...REX_ENV, REX_SERVER: "server-1" });
	await withFakeRex({ "send-key": "" }, async (calls) => {
		// Awaiting the relay is what lets a caller close a pane only after its
		// Esc has actually been sent, instead of racing the keystroke.
		await host.relayInterrupt([first, second]);
		assert.deepEqual(calls().sort(), [
			`send-key -s sess-1 -S server-1 -b ${first} esc`,
			`send-key -s sess-1 -S server-1 -b ${second} esc`,
		]);
	});
});

test("Rex readiness needs the block context and a reachable CLI, with no repair", async () => {
	await withFakeRex({ version: "rex 0.1.0-preview.21\n" }, async (calls) => {
		const readiness = await createPaneHost(REX_ENV).createCapability().probe({ timeoutMs: 5_000 });
		assert.deepEqual(readiness, { problem: null, fix: null });
		assert.deepEqual(calls(), ["version"]);
	});

	await withoutRex(async () => {
		const readiness = await createPaneHost(REX_ENV).createCapability().probe({ timeoutMs: 5_000 });
		assert.match(readiness.problem ?? "", /rex.*(reachable|PATH)/i);
		assert.equal(readiness.fix, null);
	});

	await withFakeRex({ version: "rex 0.1.0-preview.21\n" }, async () => {
		const readiness = await createPaneHost({ REX_SESSION: "sess-1" }).createCapability().probe();
		assert.match(readiness.problem ?? "", /block|session/i);
		assert.equal(readiness.fix, null);
	});
});

test("Rex readiness uses the CLI's version subcommand, not an unsupported flag", async () => {
	// The installed preview CLI answers `rex version` but rejects `rex --version`.
	await withFakeRex({ version: "rex 0.1.0-preview.21\n" }, async (calls) => {
		const readiness = await createPaneHost(REX_ENV).createCapability().probe({ timeoutMs: 5_000 });
		assert.deepEqual(readiness, { problem: null, fix: null });
		assert.deepEqual(calls(), ["version"]);
	});
});
