import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tinysubagentChild, { settleReason, writeReportFile, writeResultReport } from "../src/child.ts";
import { REPORT_TOOL_NAME } from "../src/types.ts";

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

/** The smallest `ExtensionAPI` the child factory touches. */
function stubChildApi() {
	const tools: RegisteredTool[] = [];
	const listeners = new Map<string, unknown>();
	let shutdowns = 0;
	const ctx = {
		shutdown() {
			shutdowns += 1;
		},
		/** pi hands hooks the live run's signal, and drops it once the run is over. */
		signal: undefined as AbortSignal | undefined,
	};
	return {
		tools,
		listeners,
		ctx,
		shutdowns: () => shutdowns,
		api: {
			registerTool(tool: RegisteredTool) {
				tools.push(tool);
			},
			on(event: string, handler: unknown) {
				listeners.set(event, handler);
			},
		},
	};
}

test("a normal stop is a finished turn", () => {
	assert.equal(settleReason([{ role: "assistant", stopReason: "stop" }]), "done");
	// Truncated output is still a turn the child completed and reported.
	assert.equal(settleReason([{ role: "assistant", stopReason: "length" }]), "done");
});

test("an errored turn is a failure; an interrupted one is not a settle at all", () => {
	assert.equal(settleReason([{ role: "assistant", stopReason: "error" }]), "failed");
	// Esc unwinds the loop, but the child is alive at its prompt waiting to be
	// redirected — so there is no ending here to hand to the orchestrator.
	assert.equal(settleReason([{ role: "assistant", stopReason: "aborted" }]), "interrupted");
});

test("the last assistant message decides, not the first", () => {
	assert.equal(
		settleReason([
			{ role: "assistant", stopReason: "stop" },
			{ role: "user" },
			{ role: "assistant", stopReason: "error" },
		]),
		"failed",
	);
	assert.equal(
		settleReason([
			{ role: "assistant", stopReason: "error" },
			{ role: "assistant", stopReason: "stop" },
		]),
		"done",
	);
	// An interrupt that a later turn recovered from is not an interrupt at all.
	assert.equal(
		settleReason([
			{ role: "assistant", stopReason: "aborted" },
			{ role: "assistant", stopReason: "stop" },
		]),
		"done",
	);
});

test("a turn with no assistant message at all counts as failed", () => {
	// This is the hang that mattered: a model-resolution error leaves pi idle with
	// an errored, empty assistant message. Anything that cannot be called a real
	// answer must not be reported as success.
	assert.equal(settleReason(undefined), "failed");
	assert.equal(settleReason([]), "failed");
	assert.equal(settleReason([{ role: "user" }]), "failed");
	assert.equal(settleReason([{ role: "assistant" }]), "done");
});

test("the report sidecar records done and failure distinctly", () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-child-"));
	const report = join(dir, "s.jsonl.done");
	process.env.PI_TINYSUBAGENT_REPORT = report;
	try {
		assert.equal(writeReportFile("done"), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done" });

		assert.equal(writeReportFile("failed", "error"), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "failed", reason: "error" });
	} finally {
		delete process.env.PI_TINYSUBAGENT_REPORT;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no report path means no write, and no crash", () => {
	const saved = process.env.PI_TINYSUBAGENT_REPORT;
	delete process.env.PI_TINYSUBAGENT_REPORT;
	try {
		assert.equal(writeReportFile("done"), false);
	} finally {
		if (saved !== undefined) process.env.PI_TINYSUBAGENT_REPORT = saved;
	}
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

test("the legacy signals are unchanged and also leave no staging file behind", async () => {
	await withReportFile((report) => {
		assert.equal(writeReportFile("done"), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done" });
		assert.equal(existsSync(`${report}.tmp`), false);

		assert.equal(writeReportFile("failed", "exit"), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "failed", reason: "exit" });
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
		// report, so the fallback path must not stamp over it with a blank signal.
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

test("an interrupt pi filed as an error is not a settle either", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		// Esc that lands on a tool call reaches the child as `error` with the abort
		// message — indistinguishable from a real failure by stop reason. Only the
		// run's own signal knows the difference, and this is the shape of the bug
		// that closed the orchestrator's batch under the user's feet.
		const controller = new AbortController();
		controller.abort();
		end(
			{
				messages: [
					{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" },
				],
			},
			{ ...stub.ctx, signal: controller.signal },
		);
		settled({}, stub.ctx);

		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a real error is still reported as a failure", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		// The interrupt rule must not swallow failures: this run was never aborted,
		// so the orchestrator has to hear about it or it waits on a dead child.
		end(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "Invalid API key" }] },
			stub.ctx,
		);
		settled({}, stub.ctx);

		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "failed", reason: "error" });
		// Reported, not shut down: the user may still want to read the error.
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a redirected child still reports when its next turn settles", async () => {
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

		// The redirect was typed, the child worked, and this time it finished. The
		// interrupt must not have wedged it into permanent silence.
		end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);
		settled({}, stub.ctx);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done" });
		assert.equal(stub.shutdowns(), 1);
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

test("a settle whose report write fails still closes the pane", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-child-"));
	const saved = process.env.PI_TINYSUBAGENT_REPORT;
	// A directory that does not exist, so the settle write cannot succeed.
	process.env.PI_TINYSUBAGENT_REPORT = join(dir, "missing", "s.jsonl.done");
	try {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stub.ctx);

		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;
		settled({}, stub.ctx);

		// The write is best-effort; the pane must still close. Leaving it open on a
		// settled turn hangs the watcher forever — no report, no exit code, pane alive.
		assert.equal(stub.shutdowns(), 1);
	} finally {
		if (saved === undefined) delete process.env.PI_TINYSUBAGENT_REPORT;
		else process.env.PI_TINYSUBAGENT_REPORT = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
