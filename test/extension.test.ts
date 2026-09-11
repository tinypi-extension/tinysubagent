/**
 * Registration wiring.
 *
 * Who registers nothing is as important as who registers something: outside
 * herdr there is no pane to split, so the tool must not appear at all. Both
 * sides of that decision are pinned here, and the capability probe is only a
 * matter of the environment, so the stub API needs no herdr.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/agents.ts";
import { loadConfig } from "../src/config.ts";
import { PLUGIN_ID } from "../src/herdr.ts";
import { TOOL_NAME } from "../src/spawn.ts";

interface Registered {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: { properties?: Record<string, unknown> };
	execute?: unknown;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
}

/** The smallest `ExtensionAPI` the factory touches. */
function stubApi() {
	const tools: Registered[] = [];
	const listeners = new Map<string, unknown>();
	const messages: { content: string; options: unknown }[] = [];
	return {
		tools,
		listeners,
		messages,
		api: {
			on(event: string, handler: unknown) {
				listeners.set(event, handler);
			},
			registerTool(tool: Registered) {
				tools.push(tool);
			},
			sendMessage(message: { content: string }, options: unknown) {
				messages.push({ content: message.content, options });
			},
			getAllTools() {
				return [];
			},
		},
	};
}

/** Run the factory with a chosen herdr environment, restoring it afterwards. */
function withEnv(env: Record<string, string | undefined>, run: () => void): void {
	const keys = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"];
	const saved = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const INSIDE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };

test("outside herdr the tool is not registered at all", () => {
	const stub = stubApi();
	withEnv({}, () => {
		// Inside herdr for real, but pretending not to be: the gate is the point.
		tinysubagent(stub.api as never);
	});
	assert.deepEqual(stub.tools, []);
	// Nothing is even listened for, so a stray session cannot wake anything up.
	assert.equal(stub.listeners.size, 0);
});

test("a half-set herdr environment still counts as outside herdr", () => {
	const stub = stubApi();
	withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: undefined }, () => {
		tinysubagent(stub.api as never);
	});
	assert.deepEqual(stub.tools, []);
});

test("inside herdr it registers exactly one tool under the expected name", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	assert.equal(stub.tools.length, 1);

	const [tool] = stub.tools;
	assert.equal(tool?.name, TOOL_NAME);
	assert.equal(tool?.label, "Subagent");
	assert.equal(typeof tool?.execute, "function");
	assert.match(tool?.promptSnippet ?? "", /herdr pane/);
});

test("both session hooks are registered, so watchers can be ended on shutdown", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	assert.equal(typeof stub.listeners.get("session_start"), "function");
	assert.equal(typeof stub.listeners.get("session_shutdown"), "function");
});

test("the guidelines tell the parent to wait for the result and do nothing else", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	const guidelines = stub.tools[0]?.promptGuidelines ?? [];
	assert.ok(guidelines.length > 0);
	// The parent turn is handed off to the steer message, so the parent must be told
	// to end its turn rather than fill the wait with unrelated work.
	assert.ok(
		guidelines.some((line) => /wait for the result/i.test(line) && /steer message/i.test(line)),
		`no wait-for-the-result guideline in: ${guidelines.join(" | ")}`,
	);
	// The result is an explicit hand-back now, so the parent must be told the
	// child reports it rather than told to read the child's last message.
	assert.ok(
		guidelines.some((line) => /reports? its result/i.test(line)),
		`no reported-result guideline in: ${guidelines.join(" | ")}`,
	);
});

test("the description advertises the roles found on this machine", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	const description = stub.tools[0]?.description ?? "";
	assert.match(description, /Available roles:/);

	// Whatever `discoverAgents` finds is what must be advertised — no second,
	// divergent source of truth.
	const { agents } = discoverAgents(process.cwd());
	if (agents.length === 0) {
		assert.match(description, /\(none found\)/);
	} else {
		for (const agent of agents.slice(0, 12)) {
			assert.ok(
				description.includes(`\`${agent.name}\``),
				`role ${agent.name} missing from the description`,
			);
		}
	}
});

test("the batch size in the description matches the enforced cap", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	assert.match(stub.tools[0]?.description ?? "", /up to 8/);
});

test("the profile parameter exists exactly when profiles are enabled", () => {
	// The knob must not be offered when turning it would do nothing, so the schema
	// and the config have to agree in both directions.
	// Deliberately the real global config: this test compares the advertised schema
	// against the config on disk, so a project-only lookup would miss the point.
	const { config } = loadConfig(process.cwd(), getAgentDir());
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});

	const properties = stub.tools[0]?.parameters?.properties ?? {};
	const has = (key: string) => Object.hasOwn(properties, key);

	assert.equal(has("profile"), config.enableProfiles);
	// Everything else is unconditional.
	for (const key of ["agent", "task", "tasks", "cwd"]) {
		assert.ok(has(key), `missing parameter: ${key}`);
	}

	const description = stub.tools[0]?.description ?? "";
	assert.equal(description.includes("Profiles:"), config.enableProfiles);
});

// ────────────────────────────────────────────────────────────────────────────
// The acknowledgment row
// ────────────────────────────────────────────────────────────────────────────

/** A theme whose colours are visible in the output, so the mapping can be asserted. */
const MARKING_THEME = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `*${text}*`,
};

function renderAck(details: unknown, content: string): string[] {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	const render = stub.tools[0]?.renderResult;
	assert.equal(typeof render, "function");
	const component = render?.(
		{ content: [{ type: "text", text: content }], details },
		{ expanded: false, isPartial: false },
		MARKING_THEME as never,
		{} as never,
	);
	// Wide enough that nothing wraps, and `render` pads to the width — the padding
	// is the renderer's business, not the line's.
	return (component?.render(1000) ?? []).map((line) => line.trimEnd());
}

test("the acknowledgment colours each part of the line, in the plain line's order", () => {
	const [line] = renderAck(
		{
			status: "started",
			spawned: [
				{
					agent: "scout",
					name: "scout-mcp-capability-check",
					paneId: "w1:p1B",
					profile: { name: "current", model: "oc-openai/deepseek-flash", thinking: "medium" },
					warnings: [],
				},
			],
			failed: [],
		},
		"Scout (scout-mcp-capability-check) [current] oc-openai/deepseek-flash (medium)",
	);

	assert.equal(
		line,
		"<toolTitle>*Scout*</toolTitle> <muted>(</muted><accent>scout-mcp-capability-check</accent><muted>)</muted>" +
			" <success>[current]</success> <dim>oc-openai/deepseek-flash</dim>" +
			" <muted>(</muted><thinkingMedium>medium</thinkingMedium><muted>)</muted>",
	);
});

test("a launch error is shown as the error it is, not as a spawn", () => {
	const lines = renderAck({ status: "error", error: "herdr is not reachable" }, "herdr is not reachable");
	assert.deepEqual(lines, ["<error>herdr is not reachable</error>"]);
});

test("failures and warnings keep their own colour under the spawns", () => {
	const lines = renderAck(
		{
			status: "started",
			spawned: [
				{
					agent: "worker",
					name: "worker",
					paneId: "w1:p2",
					profile: { name: "light", model: "m", thinking: "low" },
					warnings: ["agent \"worker\": unknown tool(s) bash"],
				},
			],
			failed: [{ agent: "reviewer", error: "unknown agent \"reviewer\"" }],
		},
		"Worker (worker) [light] m (low)\nfailed reviewer: unknown agent \"reviewer\"",
	);

	assert.match(lines[0] ?? "", /<accent>worker<\/accent>/);
	assert.equal(lines[1], '<error>failed reviewer: unknown agent "reviewer"</error>');
	assert.equal(lines[2], '<warning>agent "worker": unknown tool(s) bash</warning>');
});

// ────────────────────────────────────────────────────────────────────────────
// The session-start plugin offer
// ────────────────────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

const STATUS_OK = JSON.stringify({ id: "cli:status", result: { running: true, version: "0.8.2" } });

/**
 * A herdr stub that answers each command the probe makes with its own payload.
 * The hook asks about the server and then the plugin list, so a single-payload
 * stub could not drive it. Every argv is recorded so the fix can be asserted.
 */
async function withHerdrStub<T>(
	plugins: unknown,
	fn: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-offer-stub-"));
	const argvFile = join(dir, "argv.txt");
	const statusFile = join(dir, "status.json");
	const pluginsFile = join(dir, "plugins.json");
	writeFileSync(statusFile, STATUS_OK);
	writeFileSync(pluginsFile, JSON.stringify(plugins));

	const stub = join(dir, "herdr");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			`printf '%s\\n' "$*" >> ${shellQuote(argvFile)}`,
			'case "$1 $2" in',
			`  "status server") cat ${shellQuote(statusFile)} ;;`,
			`  "plugin list") cat ${shellQuote(pluginsFile)} ;;`,
			`  "plugin link"|"plugin enable") printf '%s' '{"id":"cli:plugin","result":{"type":"plugin_linked"}}' ;;`,
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);

	const saved = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;
	try {
		const result = await fn();
		const calls = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trimEnd().split("\n") : [];
		return { result, calls };
	} finally {
		if (saved === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

interface FakeUi {
	notifications: { message: string; type?: string }[];
	confirmations: { title: string; message: string }[];
}

/**
 * Fire `session_start` inside herdr against the stub, with a UI that records
 * what it was asked. Returns what the hook said and every herdr call it made.
 */
async function runSessionStart(
	plugins: unknown,
	options: { hasUI?: boolean; agree?: boolean } = {},
): Promise<{ ui: FakeUi; calls: string[] }> {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});

	const ui: FakeUi = { notifications: [], confirmations: [] };
	const ctx = {
		hasUI: options.hasUI ?? true,
		ui: {
			confirm: async (title: string, message: string) => {
				ui.confirmations.push({ title, message });
				return options.agree ?? true;
			},
			notify: (message: string, type?: string) => {
				ui.notifications.push({ message, type });
			},
		},
	};

	const handler = stub.listeners.get("session_start") as
		| ((event: unknown, ctx: unknown) => unknown)
		| undefined;
	assert.equal(typeof handler, "function");

	const { calls } = await withHerdrStub(plugins, async () => {
		await handler?.({ reason: "startup" }, ctx);
	});
	return { ui, calls };
}

const MISSING = { id: "cli:plugin", result: { plugins: [] } };
const LINKED_ON = { id: "cli:plugin", result: { plugins: [{ plugin_id: PLUGIN_ID, enabled: true }] } };
const LINKED_OFF = { id: "cli:plugin", result: { plugins: [{ plugin_id: PLUGIN_ID, enabled: false }] } };

test("session start offers to link a missing plugin, and links it on confirm", async () => {
	const { ui, calls } = await runSessionStart(MISSING);

	assert.equal(ui.confirmations.length, 1);
	assert.match(ui.confirmations[0]?.title ?? "", /Link/);
	// The dialog carries the exact command, so a decline still leaves the user
	// with the fix rather than a dead end.
	assert.match(ui.confirmations[0]?.message ?? "", /herdr plugin link/);
	assert.ok(
		calls.some((call) => call.startsWith("plugin link ") && call.endsWith("--enabled")),
		`no link call in: ${calls.join(" | ")}`,
	);
	assert.ok(ui.notifications.some((note) => /is ready/.test(note.message)));
});

test("declining the offer leaves the herdr config untouched", async () => {
	const { ui, calls } = await runSessionStart(MISSING, { agree: false });

	assert.equal(ui.confirmations.length, 1);
	assert.ok(!calls.some((call) => call.startsWith("plugin link")));
	assert.ok(!calls.some((call) => call.startsWith("plugin enable")));
});

test("a linked and enabled plugin is never offered", async () => {
	const { ui } = await runSessionStart(LINKED_ON);
	assert.deepEqual(ui.confirmations, []);
});

test("a disabled plugin is offered an enable, not a link", async () => {
	const { ui, calls } = await runSessionStart(LINKED_OFF);

	assert.equal(ui.confirmations.length, 1);
	assert.match(ui.confirmations[0]?.title ?? "", /Enable/);
	assert.ok(calls.includes(`plugin enable ${PLUGIN_ID}`), `no enable call in: ${calls.join(" | ")}`);
	assert.ok(!calls.some((call) => call.startsWith("plugin link")));
});

test("without a UI the offer is skipped entirely", async () => {
	const { ui, calls } = await runSessionStart(MISSING, { hasUI: false });
	assert.deepEqual(ui.confirmations, []);
	assert.deepEqual(calls, []);
});
