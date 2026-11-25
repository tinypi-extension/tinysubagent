/**
 * What a failed plain-terminal child hands back.
 *
 * With no pane there is no scrollback to read a crash from, so the evidence a
 * human used to read off a pane has to arrive in the report: the exit code, the
 * last lines of the child's stderr, and — for a child pi refused to start — an
 * instruction instead of a pane to look at.
 *
 * The child here is real: the wrapper script is generated and run by bash, and
 * the only thing faked is the program it launches, a script that writes to its
 * own stderr, optionally reports, and exits with the code the test chose. The
 * evidence is read where the orchestrator reads it — the text of the tool
 * result.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { TinysubagentConfig } from "../../src/config/config.ts";
import { LiveSubPanes } from "../../src/herdr/layout.ts";
import { activatePaneHost } from "../../src/pane-host/index.ts";
import { createPlainSupervisor } from "../../src/pane-host/plain.ts";
import { buildParameters } from "../../src/present/describe.ts";
import { buildResultText, type SubagentResult } from "../../src/present/result.ts";
import { waitForSubagent, type RunningSubagent, type SubagentOutcome } from "../../src/children/watcher.ts";
import type { SupervisorHandle } from "../../src/pane-host/types.ts";
import { createTool } from "../../src/pi/tool.ts";
import type { AgentDef } from "../../src/types.ts";

const worker: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	source: "user",
	path: "/tmp/worker.md",
};

/**
 * Stands in for pi: it records a session entry, writes whatever stderr the test
 * staged, optionally hands a report back, and exits with the code it was given.
 */
const FAKE_PI = `#!${process.execPath}
const fs = require("node:fs");
const env = process.env;
fs.appendFileSync(
	env.PI_TINYSUBAGENT_SESSION,
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fake turn" }] } }) + "\\n",
);
if (env.FAKE_STDERR) process.stderr.write(fs.readFileSync(env.FAKE_STDERR, "utf8"));
if (env.FAKE_REPORT) fs.writeFileSync(env.PI_TINYSUBAGENT_REPORT, env.FAKE_REPORT);
process.exit(Number(env.FAKE_EXIT ?? "0"));
`;

/** What the faked child program is told to do, staged as files it can read. */
export interface FakeChild {
	/** Written verbatim to the child's stderr. */
	stderr?: string;
	/** The report sidecar it writes, if any. */
	report?: string;
	/** Its exit code. */
	exit?: number;
}

function configWith(env: Record<string, string>): TinysubagentConfig {
	return { enableProfiles: true, profiles: {}, env, systemOne: null, classifier: null, sources: [] };
}

function stubPi(): import("@earendil-works/pi-coding-agent").ExtensionAPI {
	return { on() {}, registerTool() {}, sendMessage() {}, getAllTools: () => [] } as never;
}

/** A plain-terminal registration: no pane host, a real wrapper, a fake child program. */
function plainHarness(fake: FakeChild) {
	const root = mkdtempSync(join(tmpdir(), "tinysubagent-plain-failure-"));
	const cwd = join(root, "project");
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, FAKE_PI, "utf8");
	chmodSync(fakePi, 0o755);
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: does work\n---\nYou work.\n");

	// The child's own stderr, staged where the fake program can read it.
	const stderrFile = join(root, "stderr.txt");
	if (fake.stderr !== undefined) writeFileSync(stderrFile, fake.stderr, "utf8");

	const config = configWith({
		FAKE_STDERR: fake.stderr === undefined ? "" : stderrFile,
		FAKE_EXIT: String(fake.exit ?? 0),
		...(fake.report === undefined ? {} : { FAKE_REPORT: fake.report }),
	});

	const savedBin = process.env.PI_HERDR_PI_BIN;
	process.env.PI_HERDR_PI_BIN = fakePi;
	// No pane host detected in this environment: this registration supervises processes.
	activatePaneHost({});

	const tool = createTool({
		pi: stubPi(),
		config,
		parameters: buildParameters(config, "headless"),
		advertisedAgents: [worker],
		capability: { ensureReady: async () => null },
		columns: new LiveSubPanes(),
		watchers: new Set(),
		mode: "headless",
		route: () => async () => ({ choice: null }),
	});

	const ctx = {
		cwd,
		ui: { notify() {} },
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionFile: () => join(cwd, "sessions", "sid.jsonl"),
			getSessionId: () => "sid",
		},
	};

	return {
		tool,
		ctx,
		/** The launch scripts the spawn wrote: one per child that really started. */
		scripts: (): string[] => {
			try {
				return readdirSync(join(cwd, "sessions", "artifacts", "sid", "subagent-scripts"));
			} catch {
				return [];
			}
		},
		cleanup: () => {
			if (savedBin === undefined) delete process.env.PI_HERDR_PI_BIN;
			else process.env.PI_HERDR_PI_BIN = savedBin;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function execute(tool: { execute: unknown }, ctx: unknown, params: unknown): Promise<unknown> {
	const run = tool.execute as (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	return run("call-1", params, undefined, () => {}, ctx);
}

function contentText(result: unknown): string {
	return (result as { content?: { type: string; text?: string }[] }).content?.[0]?.text ?? "";
}

function detailRow(result: unknown): { stderr?: string; exitCode?: number; status?: string } | undefined {
	return (result as { details?: { results?: { stderr?: string; exitCode?: number; status?: string }[] } }).details
		?.results?.[0];
}

/** Wait for a process to announce its pid in a file, then read it. */
async function readPid(file: string, timeoutMs = 5_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			const pid = Number(readFileSync(file, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) return pid;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`no pid was written to ${file}`);
}

test("a failed plain child hands back its exit code and the tail of its stderr", async () => {
	// Twenty-five lines of diagnostic, so the window the report keeps is a tail and
	// not the whole stream: the cause is the end of it.
	const lines = Array.from({ length: 24 }, (_, index) => `stderr line ${String(index + 1).padStart(2, "0")}`);
	lines.push("boom: the child fell over");
	const h = plainHarness({ stderr: `${lines.join("\n")}\n`, exit: 1 });
	try {
		const result = await execute(h.tool, h.ctx, {
			tasks: [{ agent: "worker", task: "a job that dies", name: "alpha" }],
		});
		const text = contentText(result);

		// How it ended, and where it is read: in the report, since there is no pane.
		assert.match(text, /## alpha — failed \(exit 1\)/, `the exit code never reached the report: ${text}`);
		assert.match(text, /Failure output \(stderr tail\)/, `the stderr tail was not drawn: ${text}`);
		assert.match(text, /boom: the child fell over/, `the cause was not quoted: ${text}`);
		// The window is bounded: the last twenty lines survive, the lines before them
		// are gone rather than growing the report without limit.
		assert.match(text, /stderr line 06/, `the tail dropped a line inside the window: ${text}`);
		assert.doesNotMatch(text, /stderr line 05/, `the tail was not bounded: ${text}`);
		assert.equal(h.scripts().length, 1, "the failed child was not launched once");

		// The same evidence in the machine-readable form, beside the exit code.
		const row = detailRow(result);
		assert.equal(row?.exitCode, 1);
		assert.equal(row?.status, "failed (exit 1)");
		assert.match(row?.stderr ?? "", /boom: the child fell over/);
	} finally {
		h.cleanup();
	}
});

test("a child that reports keeps its report and is given no failure output", async () => {
	// The same stream a failure is quoted from, written by a child that succeeded:
	// warnings and progress chatter are not evidence, and a result has no room for
	// them.
	const h = plainHarness({
		stderr: "warming up\nloaded 3 tools\n",
		report: JSON.stringify({ type: "done", result: "the answer is 42" }),
		exit: 0,
	});
	try {
		const result = await execute(h.tool, h.ctx, {
			tasks: [{ agent: "worker", task: "a job that reports", name: "alpha" }],
		});
		const text = contentText(result);

		assert.match(text, /## alpha — completed \(reported\)/, `the report never arrived: ${text}`);
		assert.match(text, /the answer is 42/);
		assert.doesNotMatch(text, /Failure output/, `a successful child was given failure output: ${text}`);
		assert.doesNotMatch(text, /warming up/);
		assert.equal(detailRow(result)?.stderr, undefined, "a successful child's row carried stderr");
	} finally {
		h.cleanup();
	}
});

// ────────────────────────────────────────────────────────────────────────────
// A child pi refused to start: the remedy, now that there is no pane
// ────────────────────────────────────────────────────────────────────────────

/** One finished child, as the report reads it. */
function reported(ending: SubagentOutcome, paneId?: string): SubagentResult {
	return {
		name: "alpha",
		agent: "worker",
		profile: null,
		paneId,
		task: "a job pi would not start",
		outcome: ending,
		elapsedMs: 91_000,
		sessionFile: "/tmp/alpha.jsonl",
	};
}

test("a never-started child with no pane is told what to do instead of being pointed at one", () => {
	const text = buildResultText([reported({ kind: "failed", reason: "never-started", exitCode: null, summary: null })]);

	// The classification is unchanged: this is still the run that never began.
	assert.match(text, /## alpha — failed \(never-started\)/);
	// The remedy is an instruction the orchestrator can act on, and it names the
	// three real causes: no credential, a binary that will not run, the diagnostic.
	assert.match(text, /never started/, `the remedy did not say what happened: ${text}`);
	assert.match(text, /[Ll]og in/, `the remedy never mentioned the credential: ${text}`);
	assert.match(text, /pi`? it launches/, `the remedy never mentioned the binary: ${text}`);
	assert.match(text, /diagnostic/, `the remedy never pointed at what the child printed: ${text}`);
	// Nothing here claims a pane, because there is none to look at.
	assert.doesNotMatch(text, /pane/i, `a pane was named where there is none: ${text}`);
});

test("a never-started child under a pane host is still pointed at the pane left open for it", () => {
	// The pane is the remedy there: it sits at the child's prompt, so logging in
	// inside it is the fix. Unchanged by the plain remedy above.
	const text = buildResultText([
		reported({ kind: "failed", reason: "never-started", exitCode: null, summary: null }, "w1:p2"),
	]);

	assert.match(text, /## alpha — failed \(never-started\)/);
	assert.match(text, /_\(no output captured — inspect pane `w1:p2`\)_/);
});

// ────────────────────────────────────────────────────────────────────────────
// A dead process is its own ending
// ────────────────────────────────────────────────────────────────────────────

/** Await a wait that must end by itself, so a defect fails instead of hanging. */
async function endsWithoutHuman<T>(pending: Promise<T>, controller: AbortController): Promise<T> {
	const timer = setTimeout(() => controller.abort("shutdown"), 3_000);
	try {
		return await pending;
	} finally {
		clearTimeout(timer);
	}
}

test("a dead plain child is classified from its captured status, not waited on", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-failure-wait-"));
	try {
		const sessionFile = join(dir, "alpha.jsonl");
		// The session holds a turn. Nothing about a dead process makes that turn a
		// report, so it must not become the summary.
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "half a turn" }] } })}\n`,
			"utf8",
		);

		// A plain child whose process is over and whose wrapper died before stamping
		// its exit code. Its own captured status is then the only reading left.
		const handle: SupervisorHandle = {
			supervisor: {
				kind: "plain",
				detectedIn: () => true,
				createCapability: () => ({
					ensureReady: async () => null,
					probe: async () => ({ problem: null, fix: null }),
					reset: () => {},
				}),
				open: async () => handle,
				ended: async () => true,
				stop: async () => {},
				close: async () => true,
				stderr: () => "",
				exitCode: () => 137,
			},
			id: "plain-1",
		};
		const record: RunningSubagent = {
			id: "plain-1",
			name: "alpha",
			agent: "worker",
			profile: null,
			child: handle,
			writesSession: true,
			sessionFile,
			exitCodeFile: `${sessionFile}.exitcode`,
			reportFile: `${sessionFile}.done`,
			startedAt: Date.now(),
			task: "a job whose process died",
		};

		const probed: string[] = [];
		const controller = new AbortController();
		const pending = waitForSubagent(record, controller.signal, {
			pollIntervalMs: 5,
			paneExists: async (paneId) => {
				probed.push(paneId);
				return true;
			},
		});
		const outcome = await endsWithoutHuman(pending, controller);

		// The exit status, as the wrapper would have stamped it, and no summary: a
		// death is not a report and half a turn is not one either.
		assert.deepEqual(outcome, { kind: "failed", reason: "exit", exitCode: 137, summary: null });
		// A child with no pane id has no pane: nothing was probed, and nothing was
		// consumed as if a signal had arrived.
		assert.deepEqual(probed, [], "the wait treated a dead process as a vanished pane");
		assert.equal(existsSync(record.reportFile), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wrapper killed before it writes its exit code is classified, not hung on", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-failure-killed-"));
	const supervisor = createPlainSupervisor();
	try {
		const sessionFile = join(dir, "alpha.jsonl");
		const pidFile = join(dir, "wrapper.pid");
		const scriptFile = join(dir, "wrapper.sh");
		// The real wrapper writes its exit-code sidecar as it exits. This one records
		// its pid and becomes a long sleep, so it can be killed the way an OOM killer
		// would: no sidecar, no report, no farewell.
		writeFileSync(scriptFile, `#!/usr/bin/env bash\necho $$ > '${pidFile}'\nexec sleep 60\n`, "utf8");
		chmodSync(scriptFile, 0o755);

		const handle = await supervisor.open({ cwd: dir, scriptPath: scriptFile });
		const record: RunningSubagent = {
			id: handle.id,
			name: "alpha",
			agent: "worker",
			profile: null,
			child: handle,
			writesSession: false,
			sessionFile,
			exitCodeFile: `${sessionFile}.exitcode`,
			reportFile: `${sessionFile}.done`,
			startedAt: Date.now(),
			task: "a job whose wrapper is killed",
		};
		try {
			// Wait for the shell to announce itself, then kill it before it can write
			// anything: the sidecar that used to be the only ending is now missing.
			const pid = await readPid(pidFile);
			process.kill(pid, "SIGKILL");

			const controller = new AbortController();
			const pending = waitForSubagent(record, controller.signal, { pollIntervalMs: 5 });
			const outcome = await endsWithoutHuman(pending, controller);
			// The process is gone, so the wait is over. It says the status is unknown
			// rather than inventing a code or hanging until this process exits.
			assert.deepEqual(outcome, { kind: "failed", reason: "exit", exitCode: null, summary: null });
		} finally {
			await supervisor.close(handle);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
