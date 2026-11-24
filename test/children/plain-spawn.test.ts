/**
 * The spawn recipe in a plain terminal: a child as a headless process.
 *
 * No pane host is detectable in these tests, so every child is started by the
 * plain supervisor. The wrapper script is the real one and is really run by bash;
 * the only thing faked is the program the wrapper launches — a tiny script that
 * records its argv, writes a session entry, optionally writes a report sidecar,
 * and exits with a code the test chose. The real agent is never run.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { activatePaneHost, LiveSubPanes } from "../../src/pane-host/index.ts";
import { spawnOne } from "../../src/children/spawn.ts";
import { waitForSubagent, type RunningSubagent } from "../../src/children/watcher.ts";
import { watchBatch } from "../../src/pi/watch-batch.ts";
import { buildLaunchScript, buildPiArgv } from "../../src/children/launch.ts";
import type { SpawnContext } from "../../src/children/contract.ts";
import type { AgentDef } from "../../src/types.ts";

/**
 * Stands in for pi: it reads the argv the wrapper built, appends one assistant
 * entry to the child session (which is what makes the never-started grace read
 * the run as started), and reports or exits as the test asked.
 */
const FAKE_PI = `#!${process.execPath}
const fs = require("node:fs");
const env = process.env;
fs.writeFileSync(env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(
	env.PI_TINYSUBAGENT_SESSION,
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fake turn" }] } }) + "\\n",
);
if (env.FAKE_REPORT === "report") {
	fs.writeFileSync(env.PI_TINYSUBAGENT_REPORT, JSON.stringify({ type: "done", result: "reported by " + env.PI_TINYSUBAGENT_NAME }));
}
if (env.FAKE_REPORT === "failed") {
	fs.writeFileSync(env.PI_TINYSUBAGENT_REPORT, JSON.stringify({ type: "failed", reason: "error", message: "the child gave up" }));
}
process.exit(Number(env.FAKE_EXIT || 0));
`;

const worker: AgentDef = {
	name: "worker",
	description: "does work",
	body: "You work.",
	tools: ["read"],
	source: "user",
	path: "/tmp/worker.md",
};

interface Fixture {
	dir: string;
	/** A context for one spawn, with the fake pi wired in and `fakeEnv` exported by the wrapper. */
	context(fakeEnv: Record<string, string>): SpawnContext;
}

function fixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-spawn-"));
	const fakePi = join(dir, "fake-pi");
	writeFileSync(fakePi, FAKE_PI, "utf8");
	chmodSync(fakePi, 0o755);
	return {
		dir,
		context(fakeEnv) {
			return {
				cwd: dir,
				agentDir: dir,
				agentDirOverride: null,
				sessionDir: dir,
				sessionId: "sid",
				env: { PATH: process.env.PATH ?? "", PI_HERDR_PI_BIN: fakePi },
				allToolNames: ["read", "bash"],
				agents: [worker],
				config: {
					enableProfiles: false,
					profiles: {},
					env: fakeEnv,
					systemOne: null,
					classifier: null,
					sources: [],
				},
			};
		},
	};
}

/** The wrapper the spawn wrote, read back from the artifacts directory. */
function writtenScript(dir: string): string {
	const scripts = join(dir, "artifacts", "sid", "subagent-scripts");
	const [file] = readdirSync(scripts);
	assert.ok(file, "no launch script was written");
	return readFileSync(join(scripts, file), "utf8");
}

/** The argv the fake pi was really started with, once it has written it down. */
async function recordedArgv(file: string): Promise<string[]> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as string[];
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("the child never recorded its argv");
}

/** Run one batch the way the tool does, and clean up after it. */
async function runBatch(runnings: readonly RunningSubagent[], columns: LiveSubPanes) {
	return watchBatch(runnings, undefined, { watchers: new Set(), columns });
}

test("a plain child is launched headless, and its wrapper holds nothing open", async () => {
	const { dir, context } = fixture();
	try {
		// No pane host detected: this registration supervises children as processes.
		activatePaneHost({});
		const argvFile = join(dir, "argv.json");
		const columns = new LiveSubPanes();
		const spawned = await spawnOne(
			{ agent: "worker", task: "Do it.", name: "worker" },
			{ ...context({ FAKE_REPORT: "report", FAKE_ARGV: argvFile }), columns },
		);
		assert.equal(spawned.ok, true);
		if (!spawned.ok) return;

		// No pane identity at all, and no label standing in for one.
		assert.equal(spawned.running.paneId, undefined);
		assert.equal(spawned.running.child?.supervisor.kind, "plain");

		const script = writtenScript(dir);
		// The mode is explicit in the argv this wrapper runs…
		assert.match(script, /'--mode' 'json'/);
		// …and the two pane-only properties of the wrapper are gone.
		assert.equal(script.includes("read -r"), false, "a headless child has no pane to hold open");
		assert.equal(script.includes("PI_TINYSUBAGENT_PANE"), false, "there is no pane id to forward");
		// Everything the watcher depends on is untouched.
		assert.match(script, /echo "\$code \$PI_TINYSUBAGENT_ID" > '[^']+\.exitcode'/);
		assert.match(script, /export PI_TINYSUBAGENT_REPORT='[^']+\.done'/);
		assert.match(script, new RegExp(`^cd '${dir}'$`, "m"));

		const argv = await recordedArgv(argvFile);
		assert.equal(argv[0], "--session");
		assert.equal(argv[2], "-e");
		// `--mode json` is what makes the child run the prompt and exit, instead of
		// waiting for a terminal that is not there.
		const modeAt = argv.indexOf("--mode");
		assert.deepEqual(argv.slice(modeAt, modeAt + 2), ["--mode", "json"]);
		assert.match(String(argv.at(-1)), /@.*\.md$/);

		// A plain child is never recorded in the column tracker: it has no column.
		assert.deepEqual(columns.trackedIds(), []);

		const outcome = await waitForSubagent(spawned.running);
		assert.equal(outcome.kind, "completed");
		assert.equal(outcome.kind === "completed" ? outcome.via : null, "report");
		assert.deepEqual(columns.trackedIds(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a batch of plain children returns every report in one result", async () => {
	const { dir, context } = fixture();
	try {
		activatePaneHost({});
		const fakeEnv = { FAKE_REPORT: "report", FAKE_ARGV: join(dir, "argv.json") };
		const first = await spawnOne({ agent: "worker", task: "one", name: "worker" }, context(fakeEnv));
		const second = await spawnOne({ agent: "worker", task: "two", name: "scout" }, context(fakeEnv));
		assert.equal(first.ok && second.ok, true);
		if (!first.ok || !second.ok) return;

		const results = await runBatch([first.running, second.running], new LiveSubPanes());
		assert.deepEqual(
			results.map((result) => [result.name, result.outcome.kind, result.outcome.kind === "completed" ? result.outcome.summary : null]),
			[
				["worker", "completed", "reported by worker"],
				["scout", "completed", "reported by scout"],
			],
		);
		// A report is the child leaving, so both children are gone and closed.
		assert.equal(
			results.every((result) => result.paneId === undefined),
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain child that exits without reporting is classified by its exit code", async () => {
	const { dir, context } = fixture();
	try {
		activatePaneHost({});
		const failed = await spawnOne(
			{ agent: "worker", task: "x", name: "worker" },
			context({ FAKE_ARGV: join(dir, "argv.json"), FAKE_EXIT: "3" }),
		);
		assert.equal(failed.ok, true);
		if (!failed.ok) return;

		const [result] = await runBatch([failed.running], new LiveSubPanes());
		assert.equal(result?.outcome.kind, "failed");
		assert.equal(result?.outcome.kind === "failed" ? result.outcome.reason : null, "exit");
		assert.equal(result?.outcome.kind === "failed" ? result.outcome.exitCode : null, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a report that declares failure fails the plain child, and says so", async () => {
	const { dir, context } = fixture();
	try {
		activatePaneHost({});
		const spawned = await spawnOne(
			{ agent: "worker", task: "x", name: "worker" },
			context({ FAKE_REPORT: "failed", FAKE_ARGV: join(dir, "argv.json") }),
		);
		assert.equal(spawned.ok, true);
		if (!spawned.ok) return;

		const [result] = await runBatch([spawned.running], new LiveSubPanes());
		assert.equal(result?.outcome.kind, "failed");
		assert.equal(result?.outcome.kind === "failed" ? result.outcome.summary : null, "the child gave up");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain child that exits 0 without reporting still completes", async () => {
	const { dir, context } = fixture();
	try {
		activatePaneHost({});
		const spawned = await spawnOne(
			{ agent: "worker", task: "x", name: "worker" },
			context({ FAKE_ARGV: join(dir, "argv.json") }),
		);
		assert.equal(spawned.ok, true);
		if (!spawned.ok) return;

		const [result] = await runBatch([spawned.running], new LiveSubPanes());
		assert.equal(result?.outcome.kind, "completed");
		assert.equal(result?.outcome.kind === "completed" ? result.outcome.via : null, "session-exit");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the pane launch is byte-identical when the mode says pane", () => {
	// The mode is an input, not a rewrite: a pane child's wrapper keeps the hold and
	// the pane id it forwards, and its argv gains no flag.
	const base = {
		name: "w",
		agent: null,
		id: "1",
		cwd: "/proj",
		piArgv: ["pi"],
		envPath: "/usr/bin",
		agentDir: null,
		childSessionFile: "/s.jsonl",
		reportFile: "/s.jsonl.done",
		exitCodeFile: "/s.jsonl.exitcode",
	};
	// The generated timestamp is the one line that differs between any two builds.
	const strip = (script: string) => script.replace(/^# generated: .*$/m, "");
	assert.equal(strip(buildLaunchScript({ ...base, mode: "pane" })), strip(buildLaunchScript(base)));
	const pane = buildLaunchScript({ ...base, mode: "pane" });
	assert.match(pane, /export PI_TINYSUBAGENT_PANE="\$\{HERDR_PANE_ID:-\}"/);
	assert.match(pane, /read -r/);

	assert.deepEqual(
		buildPiArgv({
			piBin: "pi",
			childSessionFile: "/s.jsonl",
			childExtensionPath: "/child.ts",
			taskFile: "/t.md",
			mode: "pane",
		}),
		["pi", "--session", "/s.jsonl", "-e", "/child.ts", "@/t.md"],
	);
});
