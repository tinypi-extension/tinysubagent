/**
 * Registration wiring.
 *
 * Who registers nothing is as important as who registers something: outside
 * herdr there is no pane to split, so the tool must not appear at all. Both
 * sides of that decision are pinned here, and the capability probe is only a
 * matter of the environment, so the stub API needs no herdr.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/agents.ts";
import { loadConfig } from "../src/config.ts";
import { TOOL_NAME } from "../src/spawn.ts";

interface Registered {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: { properties?: Record<string, unknown> };
	execute?: unknown;
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

test("the guidelines say the result arrives by itself and must not be waited for", () => {
	const stub = stubApi();
	withEnv(INSIDE, () => {
		tinysubagent(stub.api as never);
	});
	const guidelines = stub.tools[0]?.promptGuidelines ?? [];
	assert.ok(guidelines.length > 0);
	// The fire-and-forget contract is what keeps a parent turn from stalling.
	assert.ok(
		guidelines.some((line) => /do not wait or poll/i.test(line) && /steer message/i.test(line)),
		`no anti-polling guideline in: ${guidelines.join(" | ")}`,
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
	const { config } = loadConfig();
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
