/**
 * Interrupt parity in a plain terminal: an abort kills the batch's process
 * groups, and nothing survives the call.
 *
 * The children here are real detached shell scripts, each with a tool
 * subprocess of its own. One shuts down on SIGTERM, the other ignores it and
 * must be killed after the grace — so the escalation is exercised rather than
 * assumed. Liveness is checked from outside, by pid: an outcome saying
 * "interrupted" while a process still runs would be exactly the orphan this
 * ticket exists to prevent.
 */

import { strict as assert } from "node:assert";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { LiveSubPanes } from "../../src/pane-host/index.ts";
import { createPlainSupervisor, type PlainSpawnOptions } from "../../src/pane-host/plain.ts";
import { registerLifecycle } from "../../src/pi/lifecycle.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import { buildResultDetails, buildResultText } from "../../src/present/result.ts";
import type { RunningSubagent } from "../../src/children/watcher.ts";

/**
 * A child that starts a tool subprocess of its own and then waits. `trap` is
 * what the test varies: one child shuts down on SIGTERM, the other ignores it,
 * and both leave a background `sleep` behind in the same process group.
 */
function childScript(pidFile: string, toolFile: string, trap: string): string {
	return [
		"#!/usr/bin/env bash",
		trap,
		"sleep 60 &",
		`echo "$!" > ${JSON.stringify(toolFile)}`,
		`echo "$$" > ${JSON.stringify(pidFile)}`,
		"wait",
		"",
	].join("\n");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${what}`);
}

function readPid(file: string): number {
	const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
	assert.ok(Number.isFinite(pid) && pid > 0, `not a pid: ${file}`);
	return pid;
}

interface Fixture {
	runnings: RunningSubagent[];
	/** The spawns the seam really made, so the detached group is observable. */
	spawns: { command: string; args: string[]; options: PlainSpawnOptions }[];
	/** Resolve once both children and their tool subprocesses are running. */
	ready: () => Promise<void>;
	/** Every pid the batch created: two children and their two tool subprocesses. */
	pids: () => number[];
	assertAllGone: () => Promise<void>;
	cleanup: () => void;
}

const GRACE_MS = 120;

async function fixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-interrupt-"));
	const spawns: Fixture["spawns"] = [];
	const supervisor = createPlainSupervisor({
		// A grace short enough for a suite, long enough for the TERM path to be real.
		graceMs: GRACE_MS,
		spawn: (command: string, args: string[], options: PlainSpawnOptions): ChildProcess => {
			spawns.push({ command, args: [...args], options });
			return spawnProcess(command, args, options);
		},
	});

	const runnings: RunningSubagent[] = [];
	const pidFiles: string[] = [];
	const toolFiles: string[] = [];
	for (const [name, disposition] of [
		["alpha", "trap 'exit 0' TERM"],
		["beta", "trap '' TERM"],
	] as const) {
		const pidFile = join(dir, `${name}.pid`);
		const toolFile = join(dir, `${name}.tool.pid`);
		const script = join(dir, `${name}.sh`);
		writeFileSync(script, childScript(pidFile, toolFile, disposition), "utf8");

		const sessionFile = join(dir, `${name}.jsonl`);
		writeFileSync(sessionFile, "", "utf8");
		const child = await supervisor.open({ cwd: dir, scriptPath: script });
		runnings.push({
			id: `${name}-id`,
			name,
			agent: null,
			profile: null,
			// No pane id: this is a child supervised as a process.
			child,
			// No session entries are written, so the never-started grace stays out of
			// the way: only the abort and the kill can end these waits.
			writesSession: false,
			sessionFile,
			exitCodeFile: `${sessionFile}.exitcode`,
			reportFile: `${sessionFile}.done`,
			startedAt: Date.now(),
			task: `task ${name}`,
		});
		pidFiles.push(pidFile);
		toolFiles.push(toolFile);
	}

	const pids = (): number[] => [...pidFiles, ...toolFiles].flatMap((file) => {
		try {
			return [readPid(file)];
		} catch {
			return [];
		}
	});

	return {
		runnings,
		spawns,
		pids,
		ready: () => until(() => pidFiles.concat(toolFiles).every((file) => {
			try {
				readPid(file);
				return true;
			} catch {
				return false;
			}
		}), 20_000, "both children and their tool subprocesses to start"),
		assertAllGone: async () => {
			const started = pids();
			assert.equal(started.length, 4, "the fixture did not start four processes");
			await until(() => started.every((pid) => !alive(pid)), 5_000, `every pid to be gone: ${started.join(", ")}`);
		},
		cleanup: () => {
			for (const pid of pids()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone, which is the point.
				}
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("an interrupt terminates each child's process group, then kills it after the grace", async () => {
	const h = await fixture();
	try {
		await h.ready();
		const started = Date.now();
		const signal = new AbortController();
		const batch = watchBatch(h.runnings, signal.signal, { watchers: new Set(), columns: new LiveSubPanes() });
		signal.abort();
		const results = await batch;

		// Every stopped child reads as interrupted, and never as a report.
		assert.deepEqual(
			results.map((result) => result.outcome),
			[
				{ kind: "interrupted", cause: "interrupt" },
				{ kind: "interrupted", cause: "interrupt" },
			],
		);
		for (const result of results) assert.equal("summary" in result.outcome, false);

		// The report says the batch was stopped, not that a pane was closed: there is
		// no pane to close, and a claim about one would send a reader looking for it.
		const text = buildResultText(results);
		assert.match(text, /interrupted \(process stopped\)/, `the ending was not named: ${text}`);
		assert.match(text, /every child was stopped/, `the batch note did not name the stop: ${text}`);
		assert.doesNotMatch(text, /pane/i, `a pane was named where there is none: ${text}`);
		assert.equal(
			buildResultDetails(results).results[0]?.status,
			"interrupted (process stopped)",
		);

		// The grace was shortened, not the production five seconds.
		assert.ok(Date.now() - started < 2_000, `the interrupt waited for the grace: ${Date.now() - started}ms`);

		// Both children were really started as their own process groups.
		assert.equal(h.spawns.length, 2);
		for (const spawn of h.spawns) assert.equal(spawn.options.detached, true);

		// Neither the child that honoured SIGTERM nor the one that ignored it — nor a
		// tool subprocess of either — is still running.
		await h.assertAllGone();
	} finally {
		h.cleanup();
	}
});

test("a shutdown under a plain wait kills the children too and leaves nothing running", async () => {
	const h = await fixture();
	try {
		await h.ready();
		const watchers = new Set<AbortController>();
		const batch = watchBatch(h.runnings, undefined, { watchers, columns: new LiveSubPanes() });

		// The session edge, reached the way the extension reaches it: one handler that
		// aborts every watcher with the shutdown reason.
		const handlers = new Map<string, () => void>();
		const pi = {
			on(event: string, handler: () => void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		registerLifecycle(pi, { configWarnings: [], offerPluginFix: async () => {}, watchers });
		assert.equal(watchers.size, 2, "the batch's waits were not registered for shutdown");
		handlers.get("session_shutdown")?.();

		const results = await batch;
		assert.deepEqual(
			results.map((result) => result.outcome),
			[
				{ kind: "interrupted", cause: "shutdown" },
				{ kind: "interrupted", cause: "shutdown" },
			],
		);
		await h.assertAllGone();
	} finally {
		h.cleanup();
	}
});
