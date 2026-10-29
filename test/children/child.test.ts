import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tinysubagentChild, {
	MAX_REPORT_REMINDERS,
	type ChildDeps,
} from "../../src/children/child.ts";
import { finishedCleanly } from "../../src/children/settle.ts";
import { writeResultReport } from "../../src/children/report.ts";
import { REPORT_TOOL_NAME } from "../../src/types.ts";

interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: { properties?: Record<string, unknown>; required?: string[] };
	execute?: (
		id: string,
		params: { result?: string },
		signal: unknown,
		onUpdate: unknown,
		ctx: { shutdown: () => void },
	) => Promise<{ content: { type: string; text: string }[] }>;
}

/** A message the child sent to its own session. */
interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
	details: unknown;
}

/** The smallest `ExtensionAPI` the child factory touches. */
function stubChildApi() {
	const tools: RegisteredTool[] = [];
	const listeners = new Map<string, unknown>();
	const sent: SentMessage[] = [];
	let shutdowns = 0;
	const ctx = {
		shutdown() {
			shutdowns += 1;
		},
	};
	return {
		tools,
		listeners,
		sent,
		ctx,
		shutdowns: () => shutdowns,
		api: {
			registerTool(tool: RegisteredTool) {
				tools.push(tool);
			},
			on(event: string, handler: unknown) {
				listeners.set(event, handler);
			},
			sendMessage(message: SentMessage, _options?: unknown) {
				sent.push(message);
			},
		},
	};
}

test("a clean turn is one that finished without an error or interrupt", () => {
	assert.equal(finishedCleanly([{ role: "assistant", stopReason: "stop" }]), true);
	// Truncated output is still a turn the child completed and reported.
	assert.equal(finishedCleanly([{ role: "assistant", stopReason: "length" }]), true);
});

test("an errored or interrupted turn is not clean", () => {
	assert.equal(finishedCleanly([{ role: "assistant", stopReason: "error" }]), false);
	// Esc unwinds the loop, but the child is alive at its prompt waiting to be
	// redirected — that is not a turn to remind to report.
	assert.equal(finishedCleanly([{ role: "assistant", stopReason: "aborted" }]), false);
});

test("the last assistant message decides, not the first", () => {
	assert.equal(
		finishedCleanly([
			{ role: "assistant", stopReason: "stop" },
			{ role: "user" },
			{ role: "assistant", stopReason: "error" },
		]),
		false,
	);
	assert.equal(
		finishedCleanly([
			{ role: "assistant", stopReason: "error" },
			{ role: "assistant", stopReason: "stop" },
		]),
		true,
	);
	// An interrupt that a later turn recovered from is not an interrupt at all.
	assert.equal(
		finishedCleanly([
			{ role: "assistant", stopReason: "aborted" },
			{ role: "assistant", stopReason: "stop" },
		]),
		true,
	);
});

test("a turn with no assistant message at all is not clean", () => {
	// A model-resolution error can leave pi idle with no assistant message; there
	// is nothing to remind and nothing to report, so the settle stays silent.
	assert.equal(finishedCleanly(undefined), false);
	assert.equal(finishedCleanly([]), false);
	assert.equal(finishedCleanly([{ role: "user" }]), false);
	assert.equal(finishedCleanly([{ role: "assistant" }]), true);
});

/**
 * Run `body` with the report sidecar pointed at a fresh temp file. The file path
 * is handed back so a test can assert on the bytes that actually landed.
 */
async function withReportFile(body: (report: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-child-"));
	const report = join(dir, "s.jsonl.done");
	const saved = process.env.PI_TINYSUBAGENT_REPORT;
	process.env.PI_TINYSUBAGENT_REPORT = report;
	try {
		await body(report);
	} finally {
		if (saved === undefined) delete process.env.PI_TINYSUBAGENT_REPORT;
		else process.env.PI_TINYSUBAGENT_REPORT = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a result report carries the payload and leaves no staging file behind", async () => {
	await withReportFile((report) => {
		assert.equal(writeResultReport("the whole answer"), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
			type: "done",
			result: "the whole answer",
		});
		// A rename, not a write-in-place: the staging file must not survive it.
		assert.equal(existsSync(`${report}.tmp`), false);
	});
});

test("no report path means writeResultReport returns false rather than throwing", () => {
	const saved = process.env.PI_TINYSUBAGENT_REPORT;
	delete process.env.PI_TINYSUBAGENT_REPORT;
	try {
		assert.equal(writeResultReport("anything"), false);
	} finally {
		if (saved !== undefined) process.env.PI_TINYSUBAGENT_REPORT = saved;
	}
});

test("the report tool replaces the done hook and requires the result", () => {
	const stub = stubChildApi();
	tinysubagentChild(stub.api as never);

	// The old, unreachable hook is gone; exactly one tool is registered.
	assert.deepEqual(
		stub.tools.map((tool) => tool.name),
		[REPORT_TOOL_NAME],
	);
	assert.equal(stub.tools[0]?.parameters?.required?.includes("result"), true);
	assert.equal(typeof stub.tools[0]?.execute, "function");
});

test("the report tool writes the payload, then asks pi to shut down", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const tool = stub.tools[0];
		assert.ok(tool?.execute);

		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
		assert.equal(stub.shutdowns(), 1);

		// A second call is a no-op: one report, one shutdown, one payload.
		await tool.execute("call-2", { result: "again" }, undefined, undefined, stub.ctx);
		assert.equal(stub.shutdowns(), 1);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
	});
});

test("a settle after a report does not overwrite the reported result", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const tool = stub.tools[0];
		assert.ok(tool?.execute);
		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);

		// pi settles as it shuts down. The payload is the whole point of the
		// report, and no other path may stamp over it.
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		assert.ok(settled);
		settled({}, {
			shutdown() {
				throw new Error("a reported child must not be shut down twice");
			},
		});
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
	});
});

test("an interrupted settle reports nothing and keeps the child alive", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		end({ messages: [{ role: "assistant", stopReason: "aborted" }] }, stub.ctx);
		settled({}, stub.ctx);

		// The user Esc'd to redirect this child. It is still alive, so there is no
		// ending to report: a sidecar here is what closed the orchestrator's batch
		// while the user was still steering, and a shutdown would kill the pane they
		// were about to type into.
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("an errored settle writes nothing and keeps the pane open", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		// A request/response error is not an ending: the human can fix the provider
		// and drive this same child on to its report, so nothing may be written and
		// nothing may end the child.
		end(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "Invalid API key" }] },
			stub.ctx,
		);
		settled({}, stub.ctx);

		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a report after a silent errored settle still lands and closes the pane", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		end(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable" }] },
			stub.ctx,
		);
		settled({}, stub.ctx);
		assert.equal(existsSync(report), false);

		// The human fixed the provider and drove the child to hand its result back:
		// that report is the only ending, and it closes the pane.
		const tool = stub.tools[0];
		assert.ok(tool?.execute);
		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);

		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
		assert.equal(stub.shutdowns(), 1);
	});
});

test("an unreported turn end after a redirect still keeps the pane open", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		end({ messages: [{ role: "assistant", stopReason: "aborted" }] }, stub.ctx);
		settled({}, stub.ctx);
		assert.equal(existsSync(report), false);

		// The redirect was typed and the child finished — but without calling the
		// report tool. An unreported turn end is not an ending: the pane stays
		// open at its prompt and the batch holds until a human asks for the
		// report. A sidecar here is what used to close a pane the human was told
		// to inspect, destroying the only copy of the child's context with it.
		end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);
		settled({}, stub.ctx);
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a failed report write keeps the child alive and says so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-child-"));
	const saved = process.env.PI_TINYSUBAGENT_REPORT;
	// A directory that does not exist, so the write cannot succeed.
	process.env.PI_TINYSUBAGENT_REPORT = join(dir, "missing", "s.jsonl.done");
	try {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const tool = stub.tools[0];
		assert.ok(tool?.execute);

		const answer = await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);
		// Nothing was reported, so the pane must stay open and the model must be
		// told, rather than the child dying with its result unreported.
		assert.equal(stub.shutdowns(), 0);
		assert.match(answer.content[0]?.text ?? "", /could not/i);
	} finally {
		if (saved === undefined) delete process.env.PI_TINYSUBAGENT_REPORT;
		else process.env.PI_TINYSUBAGENT_REPORT = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clean settle writes nothing and keeps the pane open", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);

		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		settled({}, stub.ctx);

		// An unreported turn end is not an ending: no sidecar, no shutdown. The
		// child sits at its prompt with its context intact and the watcher keeps
		// waiting; closing the pane here is what used to destroy the only copy of
		// the child's context before a human could ask for the report.
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a settle with no assistant message is silence too, not a failure", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		end({ messages: [{ role: "user" }] }, stub.ctx);

		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		settled({}, stub.ctx);

		// Nothing reportable was produced and the child is alive at its prompt, so
		// there is nothing to report and nothing to end. It waits like every other
		// non-clean settle, and the user can simply steer it into working.
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a run that never started writes nothing and registers no input hook", async () => {
	await withReportFile(async (report) => {
		// No credentials for the child's provider: pi throws out of `prompt()`
		// before any run starts, so no settle ever fires. The extension registers
		// no input hook, so nothing can intercept a typed steer as a refusal; the
		// pane stays where a human can run /login and retry.
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		assert.equal(stub.listeners.has("input"), false);
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		await settled({}, stub.ctx);

		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("an unreported finished result is reminded at once, with no check", async () => {
	const stub = stubChildApi();
	tinysubagentChild(stub.api as never, { readFinal: () => "All 12 tables migrated." });
	const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
	end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);
	const settled = stub.listeners.get("agent_settled") as (
		event: unknown,
		ctx: { shutdown: () => void },
	) => void;

	await settled({}, stub.ctx);

	// There is no check any more: the child reads no config and asks no classifier,
	// so the reminder goes straight out with nothing printed in the pane.
	assert.equal(stub.sent.length, 1);
	assert.equal(stub.sent[0]!.customType, "tinysubagent_report_reminder");
	assert.equal(stub.sent[0]!.display, true);
	assert.match(stub.sent[0]!.content, /subagent_report/);
});

test("reminders still stop at the cap", async () => {
	const stub = stubChildApi();
	tinysubagentChild(stub.api as never, { readFinal: () => "Done." });
	const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
	end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);
	const settled = stub.listeners.get("agent_settled") as (
		event: unknown,
		ctx: { shutdown: () => void },
	) => void;

	for (let i = 0; i < MAX_REPORT_REMINDERS + 2; i += 1) {
		await settled({}, stub.ctx);
	}

	assert.equal(stub.sent.length, MAX_REPORT_REMINDERS);
});
