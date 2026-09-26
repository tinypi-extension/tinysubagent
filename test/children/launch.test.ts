import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { test } from "node:test";

import {
	buildLaunchPaths,
	buildLaunchScript,
	buildPiArgv,
	buildTaskMarkdown,
	childSessionDirFor,
	resolveLaunchPrefix,
	resolvePiBin,
	safeName,
	shellEscape,
} from "../../src/children/launch.ts";
import { REPORT_TOOL_NAME } from "../../src/types.ts";

test("shell escaping keeps a string as one word", () => {
	// Always quoted: an unquoted `plain` would still be correct, but quoting
	// unconditionally means no value ever needs a special case.
	assert.equal(shellEscape("plain"), "'plain'");
	assert.equal(shellEscape("has space"), "'has space'");
	// A single quote cannot be escaped inside single quotes, so it is spliced in.
	assert.equal(shellEscape("it's"), "'it'\\''s'");
	assert.equal(shellEscape("$HOME`x`"), "'$HOME`x`'");
});

test("a name is reduced to something safe for a filename", () => {
	assert.equal(safeName("worker"), "worker");
	assert.equal(safeName("a/b c"), "ab-c");
	assert.equal(safeName("Worker One"), "worker-one");
	assert.equal(safeName(""), "subagent");
	// Nothing path-like survives: separators and dots are simply dropped.
	assert.equal(safeName("../../etc/passwd"), "etcpasswd");
});

test("the child session dir mirrors pi's own munging of the cwd", () => {
	// Verified against a real pi session directory on this machine.
	const dir = childSessionDirFor("/tmp/tinysubagent-path-check", "/Users/tinyphat/Project/subagents");
	assert.match(dir, /sessions\/--Users-tinyphat-Project-subagents--$/);
	assert.match(childSessionDirFor("/tmp/tinysubagent-path-check", "/a/b"), /sessions\/--a-b--$/);
	rmSync("/tmp/tinysubagent-path-check", { recursive: true, force: true });
});

test("launch paths live under the orchestrator's own session artifacts", () => {
	const paths = buildLaunchPaths({
		sessionDir: "/sessions/--proj--",
		sessionId: "sid-1",
		agentDir: "/tmp/tinysubagent-path-check",
		cwd: "/Users/tinyphat/Project/subagents",
		name: "worker",
		id: "abcd1234",
	});
	assert.equal(paths.artifactDir, "/sessions/--proj--/artifacts/sid-1");
	assert.equal(paths.scriptsDir, "/sessions/--proj--/artifacts/sid-1/subagent-scripts");
	assert.equal(paths.contextDir, "/sessions/--proj--/artifacts/sid-1/context");
	assert.match(paths.scriptFile, /subagent-scripts\/worker-abcd1234\.sh$/);
	assert.match(paths.taskFile, /context\/worker-.*\.md$/);
	// Both sidecars hang off the child's session file, which is how the watcher
	// finds them without any registry.
	assert.equal(paths.exitCodeFile, `${paths.childSessionFile}.exitcode`);
	assert.equal(paths.reportFile, `${paths.childSessionFile}.done`);
});

test("the task markdown carries the role, the task, and the reporting contract", () => {
	const md = buildTaskMarkdown({ body: "You are a worker.\n", task: "Do the thing." });
	assert.match(md, /^You are a worker\./);
	assert.match(md, /Complete your task autonomously\./);
	assert.match(md, /Do the thing\./);
	// The tool list is not a reliable enough teacher, so the hand-back is named
	// here too: a child that never learns the name is only ever scraped.
	assert.match(md, new RegExp(`call \`${REPORT_TOOL_NAME}\``));
	assert.match(md, /`result` argument/);
	assert.match(md, /self-contained summary/);
});

test("the task markdown stays a single well-formed document", () => {
	const md = buildTaskMarkdown({ body: "Role body.", task: "Do it." });
	assert.equal(md, md.trim());
	assert.equal(md.includes("\n\n\n"), false);
	const blocks = md.split("\n\n");
	assert.deepEqual(blocks.slice(0, 3), ["Role body.", "Complete your task autonomously.", "Do it."]);
	// Role, instruction, task, output contract — the reminder is the last thing read.
	assert.equal(blocks.length, 4);
});

test("a role with no body produces a task with no dangling blank lines", () => {
	const md = buildTaskMarkdown({ body: "   \n", task: "Do the thing." });
	assert.match(md, /^Complete your task autonomously\./);
	const none = buildTaskMarkdown({ body: null, task: "Do the thing." });
	assert.equal(none, md);
	assert.equal(buildTaskMarkdown({ body: undefined, task: "  spaced  " }).includes("spaced"), true);
});

test("child argv puts the session, the hook, and the task in that order", () => {
	const argv = buildPiArgv({
		piBin: "pi",
		childSessionFile: "/s.jsonl",
		childExtensionPath: "/child.ts",
		name: "worker",
		model: "oc-openai/deepseek-flash",
		thinking: "low",
		tools: ["read", "bash"],
		taskFile: "/t.md",
	});
	assert.deepEqual(argv, [
		"pi",
		"--session",
		"/s.jsonl",
		"-e",
		"/child.ts",
		"--name",
		"worker",
		"--model",
		"oc-openai/deepseek-flash",
		"--thinking",
		"low",
		"--tools",
		"read,bash",
		"@/t.md",
	]);
});

test("the display name reaches the child verbatim", () => {
	// No munging: the caller already decided the label, and `safeName` is only
	// for filenames. Spaces and capitals survive into `pi --name`.
	const argv = buildPiArgv({
		piBin: "pi",
		childSessionFile: "/s.jsonl",
		childExtensionPath: "/child.ts",
		name: "Worker One",
		taskFile: "/t.md",
	});
	assert.deepEqual(argv.slice(5, 7), ["--name", "Worker One"]);
	assert.equal(argv.filter((arg) => arg === "--name").length, 1);
});

test("optional flags are omitted rather than passed empty", () => {
	const argv = buildPiArgv({
		piBin: "pi",
		childSessionFile: "/s.jsonl",
		childExtensionPath: "/child.ts",
		name: "",
		model: null,
		thinking: null,
		tools: [],
		taskFile: "/t.md",
	});
	assert.deepEqual(argv, [
		"pi",
		"--session",
		"/s.jsonl",
		"-e",
		"/child.ts",
		"@/t.md",
	]);
	assert.equal(argv.includes("--model"), false);
	assert.equal(argv.includes("--tools"), false);
	assert.equal(argv.includes("--name"), false);
});

test("the wrapper always stamps the exit-code sidecar with the run id", () => {
	const script = buildLaunchScript({
		name: "worker",
		agent: "worker",
		id: "abcd1234",
		cwd: "/proj",
		piArgv: ["pi", "--session", "/s.jsonl", "-e", "/child.ts", "@/t.md"],
		envPath: "/usr/bin",
		agentDir: "/agent",
		childSessionFile: "/s.jsonl",
		reportFile: "/s.jsonl.done",
		exitCodeFile: "/s.jsonl.exitcode",
		holdOpenSecs: 0,
	});
	// The one guarantee the watcher depends on: a code and this run's id.
	assert.match(script, /echo "\$code \$PI_TINYSUBAGENT_ID" > '\/s\.jsonl\.exitcode'/);
	assert.match(script, /^#!\/usr\/bin\/env bash/);
	// Ctrl+Z must not be able to wedge a pane that has no parent shell.
	assert.match(script, /trap '' TSTP/);
	assert.match(script, /export PI_TINYSUBAGENT_REPORT='\/s\.jsonl\.done'/);
	assert.match(script, /export PI_CODING_AGENT_DIR='\/agent'/);
	assert.match(script, /^cd '\/proj'$/m);
	assert.match(script, /exit "\$code"/);
});

test("the wrapper exports the pane id herdr injected, without assuming it exists", () => {
	const script = buildLaunchScript({
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
		holdOpenSecs: 0,
	});
	assert.match(script, /export PI_TINYSUBAGENT_PANE="\$\{HERDR_PANE_ID:-\}"/);
	// No agent dir means no agent-dir export at all.
	assert.equal(script.includes("PI_CODING_AGENT_DIR"), false);
	assert.equal(script.includes("PI_TINYSUBAGENT_AGENT="), false);
});

test("a crash is held open only when the hold is enabled", () => {
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
	const held = buildLaunchScript({ ...base, holdOpenSecs: 15 });
	assert.match(held, /if \[ "\$code" -ne 0 \] && \[ "\$SECONDS" -lt 15 \]/);
	assert.match(held, /read -r/);

	const immediate = buildLaunchScript({ ...base, holdOpenSecs: 0 });
	assert.equal(immediate.includes("read -r"), false);
	// Even when held open, the exit code is stamped first, so the watcher still
	// learns how the run ended while the pane is being read.
	assert.ok(
		immediate.indexOf("> '/s.jsonl.exitcode'") < immediate.indexOf('exit "$code"'),
		"exit code must be written before exiting",
	);
});

test("the pi binary is overridable for other installs", () => {
	assert.equal(resolvePiBin({ PI_HERDR_PI_BIN: "/opt/pi" }), "/opt/pi");
	assert.equal(resolvePiBin({}), "pi");
});

test("the launch prefix only appears when it is needed", () => {
	assert.equal(resolveLaunchPrefix({ PI_HERDR_DIRENV: "0" }, "/nonexistent-cwd"), "");
	assert.equal(resolveLaunchPrefix({}, "/nonexistent-cwd"), "");
	assert.equal(
		resolveLaunchPrefix({ PI_HERDR_LAUNCH_PREFIX: "mise exec -- {cwd}" }, "/some dir"),
		"mise exec -- '/some dir'",
	);
});

test("an explicit launch prefix wins over the direnv default", () => {
	assert.equal(
		resolveLaunchPrefix(
			{ PI_HERDR_LAUNCH_PREFIX: "custom", PI_HERDR_DIRENV: "0" },
			"/nonexistent-cwd",
		),
		"custom",
	);
});
