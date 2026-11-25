/**
 * The plain-terminal supervisor: a child as a process, observed from outside.
 *
 * No pane host appears anywhere here — that is the point of the kind. The child
 * is either a fake process whose events the test drives, or a tiny shell script;
 * the real agent is never launched.
 */

import { strict as assert } from "node:assert";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createSupervisor, paneHostOf } from "../../src/pane-host/index.ts";
import { createPlainSupervisor, type SpawnChild } from "../../src/pane-host/plain.ts";

const REX_ENV = { REX_SESSION: "sess-1", REX_BLOCK: "block-full-1", REX_SERVER: "server-1" };

/** The parts of a spawned child the supervisor touches, driven by hand. */
function fakeProcess(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
	const proc = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.unref = () => {};
	return proc;
}

function recordingSpawn(proc: ChildProcess) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const spawn: SpawnChild = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		return proc;
	};
	return { calls, spawn };
}

/** Poll a promise until it says yes, failing loudly rather than hanging a suite. */
async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** True while the process exists, including one that is only a zombie. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait for a process to announce its pid in a file, then read it. */
async function readPid(file: string, timeoutMs = 20_000): Promise<number> {
	await until(async () => existsSync(file), timeoutMs);
	const pid = Number(readFileSync(file, "utf8").trim());
	assert.ok(Number.isInteger(pid) && pid > 0, `no pid was written to ${file}`);
	return pid;
}

test("with no pane host detected the chosen supervisor is the plain kind", () => {
	const supervisor = createSupervisor({});
	assert.equal(supervisor.kind, "plain");
	// A detected pane host still wins, and a plain one has no pane operations at all.
	assert.equal(createSupervisor(REX_ENV).kind, "rex");
	assert.equal(paneHostOf(supervisor), null);
	for (const member of [
		"readLayout",
		"renameChild",
		"resizeChild",
		"relayInterrupt",
		"childExists",
		"currentPaneId",
		"openChild",
		"closeChild",
	]) {
		assert.equal(member in supervisor, false, `${member} leaked into the plain supervisor`);
	}
});

test("a pane host has no output seam, and the plain kind has one", () => {
	// Absent rather than stubbed to throw: a pane child's stdout is not addressed
	// by the seam, and only the plain kind reads one.
	assert.equal("output" in createSupervisor(REX_ENV), false);
	assert.equal(typeof createPlainSupervisor().output, "function");
});

test("a plain child is started as its own process group with piped stdio and no pty", async () => {
	const proc = fakeProcess();
	const { calls, spawn } = recordingSpawn(proc);
	const supervisor = createPlainSupervisor({ spawn });

	const child = await supervisor.open({ cwd: "/tmp/work", scriptPath: "/tmp/wrap.sh", label: "worker" });

	assert.deepEqual(calls, [
		{
			command: "bash",
			args: ["/tmp/wrap.sh"],
			options: { cwd: "/tmp/work", stdio: ["ignore", "pipe", "pipe"], detached: true },
		},
	]);
	assert.equal(child.supervisor, supervisor);
	assert.equal(typeof child.id, "string");
});

test("a child is over when its process exits, and close releases the handle once", async () => {
	const proc = fakeProcess();
	const supervisor = createPlainSupervisor({ spawn: recordingSpawn(proc).spawn });
	const child = await supervisor.open({ cwd: "/tmp/work", scriptPath: "/tmp/wrap.sh" });

	assert.equal(await supervisor.ended(child), false);
	proc.emit("exit", 0, null);
	assert.equal(await supervisor.ended(child), true);

	assert.equal(await supervisor.close(child), true);
	// A second close has nothing left to release, and says so rather than lying.
	assert.equal(await supervisor.close(child), false);
	// An address this supervisor never handed out is not a live child of its own.
	assert.equal(await supervisor.ended(child), true);
});

test("stdout reaches a subscriber, and stops when it unsubscribes", async () => {
	const proc = fakeProcess();
	const supervisor = createPlainSupervisor({ spawn: recordingSpawn(proc).spawn });
	const child = await supervisor.open({ cwd: "/tmp/work", scriptPath: "/tmp/wrap.sh" });

	const chunks: string[] = [];
	const unsubscribe = supervisor.output(child, (text) => chunks.push(text));

	proc.stdout.write('{"type":"agent_start"}\n');
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(chunks, ['{"type":"agent_start"}\n']);

	unsubscribe();
	proc.stdout.write('{"type":"agent_end"}\n');
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(chunks, ['{"type":"agent_start"}\n']);
});

test("output nobody subscribes to is still drained, on both streams", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-drain-"));
	// Far more than a pipe buffer on each stream: a reader that is not draining
	// leaves the child blocked forever, and this test would time out.
	const script = join(dir, "chatty.sh");
	writeFileSync(
		script,
		[
			"#!/usr/bin/env bash",
			'for i in $(seq 1 20000); do echo "stdout line $i of a great many characters"; done',
			'for i in $(seq 1 20000); do echo "stderr line $i of a great many characters" >&2; done',
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);

	const supervisor = createPlainSupervisor();
	try {
		const child = await supervisor.open({ cwd: dir, scriptPath: script });
		assert.equal(child.supervisor.kind, "plain");
		await until(async () => (await supervisor.ended(child)) === true, 20_000);
		assert.equal(await supervisor.close(child), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop still reaches the group after its leader has exited", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-group-"));
	const toolFile = join(dir, "tool.pid");
	const script = join(dir, "leader-exits.sh");
	// A tool subprocess of the child's own, in its group, ignoring TERM so only the
	// kill can end it. The leader exits at once, so the group outlives the pid the
	// supervisor recorded — and the interrupt is meant for the group.
	writeFileSync(
		script,
		[
			"#!/usr/bin/env bash",
			`bash -c 'trap "" TERM; exec sleep 60' &`,
			`echo "$!" > '${toolFile}'`,
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);

	const supervisor = createPlainSupervisor({ graceMs: 200 });
	const child = await supervisor.open({ cwd: dir, scriptPath: script });
	let toolPid: number | null = null;
	try {
		toolPid = await readPid(toolFile);
		await until(async () => (await supervisor.ended(child)) === true, 20_000);
		assert.ok(alive(toolPid), "the fixture's group died with its leader");

		await supervisor.stop(child);
		assert.equal(alive(toolPid), false, "a stop missed the group because its leader had exited");
	} finally {
		// Never leave the fixture's sleeper behind, however the assertions went.
		if (toolPid !== null && alive(toolPid)) process.kill(toolPid, "SIGKILL");
		await supervisor.close(child);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a subscriber sees the text a real child writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-text-"));
	const script = join(dir, "talk.sh");
	writeFileSync(script, '#!/usr/bin/env bash\necho hello from the child\n', "utf8");

	const supervisor = createPlainSupervisor();
	try {
		const child = await supervisor.open({ cwd: dir, scriptPath: script });
		const text: string[] = [];
		const unsubscribe = supervisor.output(child, (chunk) => text.push(chunk));
		await until(async () => text.join("").includes("hello from the child"), 20_000);
		unsubscribe();
		await until(async () => (await supervisor.ended(child)) === true, 20_000);
		await supervisor.close(child);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a child nobody waits for cannot hold the orchestrator's process open", async () => {
	// The opened child sleeps far longer than this test waits, so a supervisor that
	// left its pipes in the event-loop count would keep the checker alive until the
	// child finished — and the checker is the only place that can be observed: this
	// test's own process is held open by the runner regardless.
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-unref-"));
	const childScript = join(dir, "sleep-child.sh");
	writeFileSync(childScript, "#!/usr/bin/env bash\nsleep 20\n", "utf8");
	const checker = join(dir, "check.ts");
	writeFileSync(
		checker,
		[
			`import { createPlainSupervisor } from ${JSON.stringify(new URL("../../src/pane-host/plain.ts", import.meta.url).href)};`,
			`await createPlainSupervisor().open({ cwd: ${JSON.stringify(dir)}, scriptPath: ${JSON.stringify(childScript)} });`,
			"",
		].join("\n"),
		"utf8",
	);
	try {
		const run = spawnSync(process.execPath, [checker], { timeout: 9000, encoding: "utf8" });
		assert.equal(run.signal, null, `the orchestrator was still held open: ${run.stderr}`);
		assert.equal(run.status, 0, run.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
