/**
 * The fork written into a child's session file.
 *
 * The point of these tests is fidelity: a shared child must start with the
 * orchestrator's conversation and nothing else — not its prompt sections, not the
 * tool call that asked for the share. Every assertion is read off the rendered
 * JSONL, which is exactly what pi will load.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { buildSharedContextFork } from "../../src/children/shared-context.ts";
import type { SharedContextSource } from "../../src/children/contract.ts";

const CHILD_FILE = "/agent/sessions/--work--/2026-11-23T06-26-27-864Z_7c1d0f2e-2b3a-4c5d-8e9f-0a1b2c3d4e5f.jsonl";
const ORCHESTRATOR_FILE = "/agent/sessions/--work--/2026-11-23T05-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";

let nextId = 0;
function message(role: "system" | "user" | "assistant", content: unknown): SessionMessageEntry {
	nextId += 1;
	return {
		type: "message",
		id: `m${nextId}`,
		parentId: null,
		timestamp: "2026-11-23T06:00:00.000Z",
		message: { role, content } as SessionMessageEntry["message"],
	};
}

/** The branch shape pi actually holds: prompt first, then the conversation. */
function branch(): SessionEntry[] {
	return [
		message("system", ""),
		message("user", "ship the thing"),
		message("assistant", "here is the plan"),
		message("user", "now use a subagent"),
		// The leaf at call time: an unresolved `subagent` tool call.
		message("assistant", [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }]),
	];
}

/**
 * A message entry's role, or undefined. Read structurally: pi writes `system`
 * entries into session files even though the pinned types omit that role.
 */
function roleOf(entry: SessionEntry): string | undefined {
	return entry.type === "message" ? (entry.message as { role?: string }).role : undefined;
}

function source(entries: SessionEntry[], version = 3): SharedContextSource {
	return { sessionFile: ORCHESTRATOR_FILE, branch: entries, version };
}

function render(entries: SessionEntry[] = branch(), version = 3): { header: SessionHeader; body: SessionEntry[]; jsonl: string } {
	const fork = buildSharedContextFork({ source: source(entries, version), childSessionFile: CHILD_FILE, cwd: "/work" });
	assert.ok(fork, "no fork was rendered");
	const lines = fork.jsonl.trimEnd().split("\n");
	return {
		header: JSON.parse(lines[0] ?? "") as SessionHeader,
		body: lines.slice(1).map((line) => JSON.parse(line) as SessionEntry),
		jsonl: fork.jsonl,
	};
}

test("the header is the child's own session, forked from the orchestrator", () => {
	const { header } = render();
	// pi names session files `<timestamp>_<session-id>.jsonl`; a header id that
	// disagreed would make the file contradict itself.
	assert.equal(header.type, "session");
	assert.equal(header.id, "7c1d0f2e-2b3a-4c5d-8e9f-0a1b2c3d4e5f");
	assert.equal(header.cwd, "/work");
	assert.equal(header.parentSession, ORCHESTRATOR_FILE);
	assert.equal(header.version, 3);
});

test("the body is the branch up to its last user entry, so the delegating tool call is never inherited", () => {
	const { body } = render();
	assert.deepEqual(
		body.map((entry) => roleOf(entry) ?? entry.type),
		["user", "assistant", "user"],
	);
	// A shared child that inherited the call would spend its life holding an
	// unresolved tool call and could read the half-finished batch as its own work.
	assert.equal(body.some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message).includes("subagent")), false);
});

test("no system entry survives, and the entries chain under the new header", () => {
	const { body } = render();
	assert.equal(body.some((entry) => roleOf(entry) === "system"), false);
	// pi's own forks root the branch at the header: first entry parentless, then
	// one link per entry, each id kept from the original branch.
	assert.equal(body[0]?.parentId, null);
	for (let index = 1; index < body.length; index += 1) {
		assert.equal(body[index]?.parentId, body[index - 1]?.id);
	}
});

test("a compacted branch is copied compacted, summary and all", () => {
	// `buildContextEntries()` is what the orchestrator's model sees, so a summary
	// standing in for the turns it replaced must travel with the fork.
	const compaction: SessionEntry = {
		type: "compaction",
		id: "c0",
		parentId: null,
		timestamp: "2026-11-23T06:00:00.000Z",
		summary: "they agreed to ship the thing",
		firstKeptEntryId: "m2",
		tokensBefore: 900,
	};
	const { body } = render([compaction, message("user", "go on then"), message("assistant", "done")]);
	// The summary survives; the reply after the last user entry is the cut's business.
	assert.deepEqual(body.map((entry) => entry.type), ["compaction", "message"]);
	assert.match(JSON.stringify(body[0]), /they agreed to ship the thing/);
});

test("a branch with no user entry has nothing to fork", () => {
	// Only a prompt was written, so the child would learn nothing but the
	// orchestrator's system text — which is excluded anyway.
	assert.equal(
		buildSharedContextFork({ source: source([message("system", "")]), childSessionFile: CHILD_FILE, cwd: "/work" }),
		null,
	);
});
