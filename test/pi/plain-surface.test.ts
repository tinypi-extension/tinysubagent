/**
 * The advertised surface in a plain terminal.
 *
 * Everything the orchestrator is told has to describe what this terminal will
 * actually do: a pane host is one of the two supervision modes, not the only one.
 * Three seams carry that: the strings and schema in `src/present/describe.ts` as a
 * pure function of the mode, the profile list's single ordering authority
 * (`availableProfileNames`) as a pure function of config + mode, and `execute`
 * for the two endings a mixed batch has — the child that runs and the child that
 * is refused by name.
 *
 * The plain child here is real: the wrapper script is generated and run by bash,
 * and the only thing faked is the program it launches.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type TinysubagentConfig } from "../../src/config/config.ts";
import { draftProfiles, readDraft } from "../../src/config/draft.ts";
import { LiveSubPanes } from "../../src/herdr/layout.ts";
import { activatePaneHost } from "../../src/pane-host/index.ts";
import { buildParameters, buildPromptSnippet, buildToolDescription } from "../../src/present/describe.ts";
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
 * Stands in for pi: it records its argv and appends one assistant entry, which is
 * what makes the never-started grace read the run as started, then reports.
 */
const FAKE_PI = `#!${process.execPath}
const fs = require("node:fs");
const env = process.env;
fs.appendFileSync(
	env.PI_TINYSUBAGENT_SESSION,
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fake turn" }] } }) + "\\n",
);
fs.writeFileSync(env.PI_TINYSUBAGENT_REPORT, JSON.stringify({ type: "done", result: "reported by " + env.PI_TINYSUBAGENT_NAME }));
process.exit(0);
`;

function configWith(profiles: TinysubagentConfig["profiles"]): TinysubagentConfig {
	return { enableProfiles: true, profiles, env: {}, systemOne: null, classifier: null, sources: [] };
}

/** One agy-backed profile, one pi-backed profile: the mixed harness a batch can ask for. */
const MIXED = configWith({
	gemini: { harness: "agy", model: "gm", thinking: "medium" },
	light: { model: "m-light", thinking: "low" },
});

// ────────────────────────────────────────────────────────────────────────────
// The strings and the schema, as a function of the mode
// ────────────────────────────────────────────────────────────────────────────

const PANE_SNIPPET = "Delegate a task to a subagent running in its own herdr pane";
const PLAIN_SNIPPET = "Delegate a task to a subagent running as its own headless process";

test("under a pane host the advertised surface promises exactly what it always did", () => {
	const description = buildToolDescription([worker], MIXED, "pane");
	assert.match(description, /each running in its own herdr pane/);
	assert.match(description, /the subagents' panes are closed/);
	assert.equal(buildPromptSnippet("pane"), PANE_SNIPPET);
	assert.match(JSON.stringify(buildParameters(MIXED, "pane")), /each with its own pane/);
});

test("in a plain terminal no advertised word claims a pane or narrates a layout", () => {
	const description = buildToolDescription([worker], MIXED, "headless");
	assert.doesNotMatch(description, /pane/i);
	assert.doesNotMatch(description, /herdr/i);
	assert.match(description, /each running as its own process/);
	// The delivery contract is unchanged: still one blocking call, still one result.
	assert.match(description, /returns when every subagent has finished/);
	assert.equal(buildPromptSnippet("headless"), PLAIN_SNIPPET);
	// The task array's own description is part of the schema the model reads.
	const schema = JSON.stringify(buildParameters(MIXED, "headless"));
	assert.doesNotMatch(schema, /pane/i);
	assert.match(schema, /each started as its own process|each running as its own process/);
});

test("the plain-terminal description names the interrupt ending it can actually reach", () => {
	const description = buildToolDescription([worker], MIXED, "headless");
	// A headless child cannot be steered, and no pane is closed on its behalf.
	assert.doesNotMatch(description, /relayed to every live subagent/);
	assert.match(description, /interrupt/);
});

// ────────────────────────────────────────────────────────────────────────────
// The settings surface is mode-free
// ────────────────────────────────────────────────────────────────────────────

test("the settings UI lists every configured profile, agy-backed ones included", () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-plain-surface-draft-"));
	try {
		const file = join(dir, "tinysubagent.jsonc");
		writeFileSync(file, JSON.stringify({ enableProfiles: true, profiles: MIXED.profiles }));
		// The settings screen reads the file, never the offered list: a profile the
		// current mode cannot run is still one the user configures for a pane host.
		const draft = readDraft(file);
		assert.deepEqual(draftProfiles(draft), ["gemini", "light"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ────────────────────────────────────────────────────────────────────────────
// execute: a mixed batch fails only the child that cannot run here
// ────────────────────────────────────────────────────────────────────────────

function stubPi(): import("@earendil-works/pi-coding-agent").ExtensionAPI {
	return { on() {}, registerTool() {}, sendMessage() {}, getAllTools: () => [] } as never;
}

/** A plain-terminal registration: no pane host, a real wrapper, a fake child program. */
function plainHarness(config: TinysubagentConfig) {
	const root = mkdtempSync(join(tmpdir(), "tinysubagent-plain-surface-"));
	const cwd = join(root, "project");
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, FAKE_PI, "utf8");
	chmodSync(fakePi, 0o755);
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: does work\n---\nYou work.\n");

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

test("a mixed batch refuses the agy child by name and still runs the pi child", async () => {
	const h = plainHarness(MIXED);
	try {
		const result = await execute(h.tool, h.ctx, {
			tasks: [
				{ agent: "worker", task: "the agy job", profile: "gemini", name: "gem" },
				{ agent: "worker", task: "the pi job", profile: "light", name: "lite" },
			],
		});
		const text = contentText(result);
		// The refusal names the reason and the profile, and is not "unknown profile".
		assert.match(text, /failed worker: profile "gemini" cannot be used here/);
		assert.match(text, /pane host/);
		assert.doesNotMatch(text, /unknown profile/);
		// The sibling is exactly what the caller asked for, so it runs and reports.
		assert.match(text, /reported by lite/, `the pi child did not run: ${text}`);
		assert.equal(h.scripts().length, 1, "a refused profile still wrote a launch script");
	} finally {
		h.cleanup();
	}
});
