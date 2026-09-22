import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tinysubagentChild from "../../src/children/child.ts";
import { preflightFailure } from "../../src/children/preflight.ts";
import { settleReason } from "../../src/children/settle.ts";
import { writeReportFile, writeResultReport } from "../../src/children/report.ts";
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

/** The smallest `ExtensionAPI` the child factory touches. */
function stubChildApi(
	overrides: {
		/** False stands for a run in flight, where a typed message is a steer. */
		idle?: boolean;
		/** False stands for pi with no model selected at all. */
		model?: boolean;
		/** What `hasConfiguredAuth` says — the cheap check pi runs first. */
		configured?: boolean;
		/** What the registry's local status says, when the cheap check said no. */
		statusConfigured?: boolean;
		/** What the provider lookup pi falls back to returns (undefined = nothing). */
		providerAuth?: unknown;
		/** Whether that lookup throws, as it does when the provider is unreachable. */
		providerAuthThrows?: boolean;
		/** Whether the cheap check itself throws. */
		hasConfiguredAuthThrows?: boolean;
		/** Whether asking about OAuth throws. */
		isUsingOAuthThrows?: boolean;
		oauth?: boolean;
	} = {},
) {
	const opts = {
		idle: true,
		model: true,
		configured: true,
		statusConfigured: false,
		providerAuth: undefined as unknown,
		providerAuthThrows: false,
		hasConfiguredAuthThrows: false,
		isUsingOAuthThrows: false,
		oauth: false,
		...overrides,
	};
	const tools: RegisteredTool[] = [];
	const listeners = new Map<string, unknown>();
	let shutdowns = 0;
	const nudges: string[] = [];
	const ctx = {
		shutdown() {
			shutdowns += 1;
		},
		/** pi hands hooks the live run's signal, and drops it once the run is over. */
		signal: undefined as AbortSignal | undefined,
		isIdle: () => opts.idle,
		model: opts.model ? { provider: "oc-openai" } : undefined,
		modelRegistry: {
			hasConfiguredAuth: () => {
				if (opts.hasConfiguredAuthThrows) throw new Error("registry exploded");
				return opts.configured;
			},
			getProviderAuthStatus: () => ({ configured: opts.statusConfigured }),
			getProviderAuth: async () => {
				if (opts.providerAuthThrows) throw new Error("provider unreachable");
				return opts.providerAuth;
			},
			isUsingOAuth: () => {
				if (opts.isUsingOAuthThrows) throw new Error("cannot say");
				return opts.oauth;
			},
		},
	};
	return {
		tools,
		listeners,
		ctx,
		shutdowns: () => shutdowns,
		nudges: () => nudges,
		api: {
			registerTool(tool: RegisteredTool) {
				tools.push(tool);
			},
			on(event: string, handler: unknown) {
				listeners.set(event, handler);
			},
			/** The settle handler's bounded self-correction, recorded for assertions. */
			sendUserMessage(content: string) {
				nudges.push(content);
			},
		},
	};
}

/** The `input` hook, as pi calls it: awaited, from inside `prompt()`. */
type InputHook = (event: unknown, ctx: unknown) => unknown;

function typeInto(stub: ReturnType<typeof stubChildApi>, text = "carry on"): Promise<unknown> {
	const input = stub.listeners.get("input") as InputHook | undefined;
	assert.ok(input, "the child must listen for input");
	return Promise.resolve(input({ type: "input", text, source: "interactive" }, stub.ctx));
}

/** The `agent_end` hook, as pi calls it: it records the phase's messages. */
type EndHook = (event: unknown, ctx: unknown) => void;

/** The `agent_settled` hook, as pi calls it: it decides the run's ending. */
type SettleHook = (event: unknown, ctx: unknown) => unknown;

/** Record a finished agent phase, as pi does just before it settles. */
function finishTurn(stub: ReturnType<typeof stubChildApi>, stopReason = "stop"): void {
	const end = stub.listeners.get("agent_end") as EndHook | undefined;
	assert.ok(end, "the child must listen for agent_end");
	end({ messages: [{ role: "assistant", stopReason }] }, stub.ctx);
}

/** Fire the settle hook for the phase `finishTurn` recorded. */
function settleNow(stub: ReturnType<typeof stubChildApi>): void {
	const settled = stub.listeners.get("agent_settled") as SettleHook | undefined;
	assert.ok(settled, "the child must listen for agent_settled");
	settled({}, stub.ctx);
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

		// A blank message is no message: the reader would ignore it anyway, and a key
		// that is always present is one every reader has to check.
		assert.equal(writeReportFile("failed", "error", "   "), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "failed", reason: "error" });

		assert.equal(writeReportFile("failed", "error", "  no API key  "), true);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
			type: "failed",
			reason: "error",
			message: "no API key",
		});
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

test("an unreported done settle nudges the child to report, then holds", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		// The model finished its turn without calling the report tool. Prompt text
		// alone has not made that reliable in practice, so the child's own settle
		// handler asks it once — a bounded self-correction before the hold.
		finishTurn(stub);
		settleNow(stub);

		assert.equal(stub.nudges().length, 1);
		assert.match(stub.nudges()[0] ?? "", new RegExp(REPORT_TOOL_NAME));

		// Still a hold: no sidecar, no shutdown, the pane stays open.
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("the report nudge is capped so a model that never reports cannot loop", async () => {
	await withReportFile(() => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		// Each unreported turn end asks again, up to the cap. The nudge is a full
		// model turn, so uncapped it would be a loop far worse than the hold it
		// exists to avoid. The exact count pins the cap: a loose assertion would let
		// `REPORT_NUDGE_LIMIT` drift without the test noticing.
		finishTurn(stub);
		for (let i = 0; i < 10; i += 1) settleNow(stub);

		assert.equal(stub.nudges().length, 2);
	});
});

test("a child the user redirected is not nudged", async () => {
	await withReportFile((report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		// The user pressed Esc to redirect. The last thing they want is the child
		// immediately talking over them with an automatic reminder.
		finishTurn(stub, "aborted");
		settleNow(stub);

		assert.equal(stub.nudges().length, 0);
		assert.equal(existsSync(report), false);
	});
});

test("a child that already handed its result back is not nudged", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);
		const tool = stub.tools[0];
		assert.ok(tool?.execute);
		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);

		// pi settles as it shuts down. The result is already written, so a nudge
		// here would only be noise on a child that is on its way out.
		finishTurn(stub);
		settleNow(stub);

		assert.equal(stub.nudges().length, 0);
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
	});
});

test("a report after an unreported settle still lands and closes the pane", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		// The reminder asked, and the child then does call the tool. The hand-back has
		// to work exactly as it does on the first pass: the settle before it wrote
		// nothing and shut nothing down, so there is no state for a late report to trip
		// over. A reminder a child cannot act on would be noise, not a correction —
		// this is the half of the contract the nudge exists for.
		finishTurn(stub);
		settleNow(stub);
		assert.equal(stub.nudges().length, 1);

		const tool = stub.tools[0];
		assert.ok(tool?.execute);
		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);

		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
		assert.equal(stub.shutdowns(), 1);

		// The settle that follows the shutdown is not nudged again: the child has
		// already handed its result back.
		finishTurn(stub);
		settleNow(stub);
		assert.equal(stub.nudges().length, 1);
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

		// Nothing reportable was produced and the child is alive at its prompt:
		// reporting `no-output` would mark the batch failed for a child the user
		// can simply steer into working. It waits like an interrupt does; a real
		// `error` stop reason is the one failure that still reports.
		assert.equal(existsSync(report), false);
		assert.equal(stub.shutdowns(), 0);
	});
});

test("the refusal message names the provider and the fix", () => {
	// The orchestrator cannot see the child's pane, so the report has to say which
	// provider needs attention and what the user should run.
	const key = preflightFailure({ provider: "oc-openai", usesOAuth: false, cause: null });
	assert.match(key, /no API key.*oc-openai/);
	assert.match(key, /\/login oc-openai/);
	const oauth = preflightFailure({ provider: "anthropic", usesOAuth: true, cause: null });
	assert.match(oauth, /authentication.*anthropic/);
	assert.match(oauth, /\/login anthropic/);
	assert.match(preflightFailure({ provider: null, usesOAuth: false, cause: null }), /no model/);
	// A lookup that failed for its own reasons says so, instead of claiming there is
	// no key when the truth is that nobody could tell.
	const cause = preflightFailure({
		provider: "oc-openai",
		usesOAuth: false,
		cause: "fetch failed",
	});
	assert.match(cause, /could not resolve credentials.*oc-openai.*fetch failed/);
});

test("a prompt pi will refuse is reported instead of leaving the batch waiting", async () => {
	await withReportFile(async (report) => {
		// No credentials for the child's provider: pi throws out of `prompt()`
		// before any run starts, so no settle ever fires. Without this report the
		// watcher waits on an idle child forever and the orchestrator hangs.
		const stub = stubChildApi({ configured: false });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
			type: "failed",
			reason: "error",
			message:
				'pi could not start this subagent: no API key configured for "oc-openai" — run /login oc-openai.',
		});
		// Reported, not killed: the pane is where the user logs in and retries.
		assert.equal(stub.shutdowns(), 0);
	});
});

test("a child that can actually run reports nothing on input", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi();
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		// A healthy prompt is not an error: writing here would fail a running child.
		assert.equal(existsSync(report), false);
	});
});

test("the provider lookup pi falls back to counts as credentials", async () => {
	await withReportFile(async (report) => {
		// An OAuth credential, or an env-var key: `hasConfiguredAuth` is false but
		// pi's own fallback resolves it, so the child must not call that a failure.
		const stub = stubChildApi({ configured: false, providerAuth: { apiKey: "sk-live" }, oauth: true });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		assert.equal(existsSync(report), false);
	});
});

test("a credential the registry already knows about is never resolved", async () => {
	await withReportFile(async (report) => {
		// The skew that matters: the availability snapshot has not caught up, so the
		// cheap check says no — but a stored credential exists, and resolving it is
		// the step that refreshes an OAuth token and can fail. pi's own check stops
		// at the credential it can see, so this child must stop there too.
		const stub = stubChildApi({
			configured: false,
			statusConfigured: true,
			providerAuthThrows: true,
		});
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		assert.equal(existsSync(report), false);
	});
});

test("an unreachable provider is reported with its cause, not a guess", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi({ configured: false, providerAuthThrows: true });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		const payload = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(payload.type, "failed");
		assert.match(payload.message, /could not resolve credentials/);
		assert.match(payload.message, /provider unreachable/);
	});
});

test("a hook that throws still reports rather than going silent", async () => {
	await withReportFile(async (report) => {
		// pi swallows a throwing hook, so a failure to reach a verdict must not be
		// allowed to become the silence this hook exists to break.
		const stub = stubChildApi({ hasConfiguredAuthThrows: true });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		assert.equal(JSON.parse(readFileSync(report, "utf8")).type, "failed");
	});
	await withReportFile(async (report) => {
		// The same, one step later: the OAuth question only picks the wording, so a
		// registry that cannot answer it must not cost the report.
		const stub = stubChildApi({ configured: false, isUsingOAuthThrows: true });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		const payload = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(payload.type, "failed");
		assert.match(payload.message, /no API key/);
	});
});

test("a message typed into a live run is a steer, not a refused prompt", async () => {
	await withReportFile(async (report) => {
		// Mid-run pi queues the text and validates nothing, and the run it joins
		// reports for itself when it settles.
		const stub = stubChildApi({ idle: false, configured: false });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		assert.equal(existsSync(report), false);
	});
});

test("a child with no model selected reports that instead of hanging", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi({ model: false });
		tinysubagentChild(stub.api as never);

		await typeInto(stub);

		const payload = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(payload.type, "failed");
		assert.equal(payload.reason, "error");
		assert.match(payload.message, /no model/);
	});
});

test("a refusal cannot overwrite a result the child already handed back", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi({ configured: false });
		tinysubagentChild(stub.api as never);
		const tool = stub.tools[0];
		assert.ok(tool?.execute);
		await tool.execute("call-1", { result: "PONG" }, undefined, undefined, stub.ctx);

		// Between the report and pi's shutdown the user types: the result is the
		// whole point of the report, so it must survive.
		await typeInto(stub);

		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { type: "done", result: "PONG" });
	});
});

test("an interrupted child that cannot start its next run is still reported", async () => {
	await withReportFile(async (report) => {
		const stub = stubChildApi({ configured: false });
		tinysubagentChild(stub.api as never);
		const end = stub.listeners.get("agent_end") as (event: unknown, ctx: unknown) => void;
		const settled = stub.listeners.get("agent_settled") as (
			event: unknown,
			ctx: { shutdown: () => void },
		) => void;

		// The user Esc'd to redirect — silence, as designed.
		const controller = new AbortController();
		controller.abort();
		end({ messages: [{ role: "assistant", stopReason: "error" }] }, { ...stub.ctx, signal: controller.signal });
		settled({}, stub.ctx);
		assert.equal(existsSync(report), false);

		// The redirect they typed cannot run at all. Silence here would be the
		// interrupt rule swallowing a real failure, which is the bug it must not have.
		await typeInto(stub, "try again");
		const payload = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(payload.type, "failed");
		assert.match(payload.message, /no API key/);
	});
});
