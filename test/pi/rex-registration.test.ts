/**
 * Tool registration inside a Rex block. Herdr registration tests stay as they
 * are; this file only pins the new host's gate.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import tinysubagent from "../../index.ts";
import { TOOL_NAME } from "../../src/types.ts";

function stubApi() {
	const tools: { name?: string }[] = [];
	return {
		tools,
		api: {
			on() {},
			registerTool(tool: { name?: string }) {
				tools.push(tool);
			},
			sendMessage() {},
			getAllTools() {
				return [];
			},
		},
	};
}

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
	const keys = ["REX_SESSION", "REX_BLOCK", "REX_SERVER", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"];
	const saved = keys.map((key) => [key, process.env[key]] as const);
	for (const key of keys) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
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

test("a Rex block registers the subagent tool", () => {
	const stub = stubApi();
	withEnv({ REX_SESSION: "sess-1", REX_BLOCK: "block-full-1" }, () => {
		tinysubagent(stub.api as never);
	});
	assert.deepEqual(
		stub.tools.map((tool) => tool.name),
		[TOOL_NAME],
	);
});

test("a half-set Rex context stays outside the pane hosts", () => {
	const stub = stubApi();
	withEnv({ REX_SESSION: "sess-1" }, () => {
		tinysubagent(stub.api as never);
	});
	assert.deepEqual(stub.tools, []);
});
