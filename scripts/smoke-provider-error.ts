/**
 * Provider-error smoke test: a child whose model endpoint dies must be held, not
 * reported.
 *
 * A request/response error is not an ending. The child stays at its prompt with
 * its context intact, the orchestrator is told nothing, and the batch keeps
 * waiting. A human can then fix the provider and drive that same child on to
 * `subagent_report`, which lands as `completed (reported)` and closes the pane.
 *
 * It drives a real child in a real pane against a local HTTP server that answers
 * 503 while the child is held, then serves a real OpenAI-compatible stream that
 * calls `subagent_report` once the endpoint is healthy again. No external
 * provider is involved.
 *
 * Usage: node scripts/smoke-provider-error.ts [agent] [--retries] [--no-auth]
 *
 * `--retries` keeps pi's automatic retry on, so the 503 has to survive the
 * retry-and-give-up path — the path a real provider outage actually takes, and
 * the one most likely to write something early. Both shapes must hold silently.
 *
 * `--no-auth` drops the child's credentials instead, so pi refuses the prompt
 * before any run starts. A refusal is not an ending either: nothing reaches the
 * orchestrator while the pane is open, and no run ever begins — so the watcher's
 * never-started grace is what ends the call, as `failed (never-started)`, with
 * the pane left open for the `/login` that is still the fix.
 *
 * Both shapes are read from the *returned tool result*, because that is where a
 * batch's reports arrive: nothing is ever steered into the orchestrator.
 */

import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { currentPaneId, herdrPaneExists, herdrPaneLayout, herdrPluginInfo, PLUGIN_ID } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/types.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
	console.error(`\nFAIL ${message}`);
	process.exit(1);
}

const plugin = await herdrPluginInfo(PLUGIN_ID);
if (!plugin?.enabled) fail(`herdr plugin ${PLUGIN_ID} is missing or disabled`);

const args = process.argv.slice(2);
const retries = args.includes("--retries");
const noAuth = args.includes("--no-auth");

const { agents } = discoverAgents(process.cwd());
const agentName = args.find((arg) => !arg.startsWith("--")) ?? "worker";
const agent = agents.find((entry) => entry.name === agentName) ?? agents[0];
if (!agent) fail("no agents found");

// ── The endpoint: 503 while held, a real report-calling stream once healthy ──
let healthy = false;
let healthyRequests = 0;

const chunk = (delta: unknown, finishReason: string | null) => ({
	id: "chatcmpl-smoke",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model: "deepseek-flash",
	choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const server = createServer((req, res) => {
	req.resume();
	if (!healthy) {
		res.writeHead(503, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ error: { message: "Service Unavailable (smoke)", type: "server_error" } }),
		);
		return;
	}

	healthyRequests += 1;
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

	if (healthyRequests === 1) {
		// The one turn the human drove: hand the result back through the tool.
		send(
			chunk(
				{
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_smoke_report",
							type: "function",
							function: {
								name: "subagent_report",
								arguments: JSON.stringify({ result: "PONG" }),
							},
						},
					],
				},
				null,
			),
		);
		send(chunk({}, "tool_calls"));
	} else {
		// Anything after the report is not our contract; do not loop on the tool.
		send(chunk({ role: "assistant", content: "Reported." }, null));
		send(chunk({}, "stop"));
	}
	send({
		id: "chatcmpl-smoke",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "deepseek-flash",
		choices: [],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
	res.write("data: [DONE]\n\n");
	res.end();
});
const port: number = await new Promise((resolve) => {
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve(typeof address === "object" && address !== null ? address.port : 0);
	});
});
const endpoint = `http://127.0.0.1:${port}/v1`;

// ── A child agent dir that points the model at it ───────────────────────────
const scratch = join(tmpdir(), `tinysubagent-smoke-provider-${Date.now()}`);
const childAgentDir = join(scratch, "agent");
mkdirSync(childAgentDir, { recursive: true });
writeFileSync(
	join(childAgentDir, "models.json"),
	JSON.stringify({
		providers: {
			"oc-openai": {
				baseUrl: endpoint,
				api: "openai-completions",
				...(noAuth ? {} : { apiKey: "smoke" }),
				models: [
					{
						id: "deepseek-flash",
						name: "Smoke 503",
						contextWindow: 200_000,
						maxTokens: 8_192,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
	"utf8",
);
// The provider's own SDK retries are always off — one HTTP request, one outcome.
// pi's retries are the interesting knob: off means the 503 settles immediately,
// on means it has to exhaust its backoff first. Either way the child must hold.
writeFileSync(
	join(childAgentDir, "settings.json"),
	JSON.stringify(
		retries
			? { retry: { enabled: true, maxRetries: 2, baseDelayMs: 500, provider: { maxRetries: 0 } } }
			: { retry: { enabled: false, provider: { maxRetries: 0 } } },
	),
	"utf8",
);

// The generated wrapper prepends this to the child's pi command, so the child runs
// against the scratch agent dir without touching the user's own configuration.
const previousPrefix = process.env.PI_HERDR_LAUNCH_PREFIX;
process.env.PI_HERDR_LAUNCH_PREFIX = `env PI_CODING_AGENT_DIR=${childAgentDir}`;

// ── Session dir of our own ──────────────────────────────────────────────────
const sessionDir = join(getAgentDir(), "sessions", "--tinysubagent-smoke--");
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, `smoke-provider-${Date.now()}.jsonl`);

function cleanup(): void {
	rmSync(scratch, { recursive: true, force: true });
	server.close();
}

// ── Stub surface ────────────────────────────────────────────────────────────
const tools: Record<string, unknown>[] = [];
const sent: { message: { content: string }; options: unknown }[] = [];

const api = {
	on() {},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string }, options: unknown) {
		sent.push({ message, options });
		console.log(`\n!!! STEER MESSAGE ARRIVED (${sent.length}) !!!\n${message.content}`);
	},
	getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: TOOL_NAME }],
};

const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	thinkingLevel: "low",
	model: { provider: "oc-openai", id: "deepseek-flash" },
	sessionManager: {
		getSessionFile: () => sessionFile,
		getSessionId: () => "smoke-provider",
		getCwd: () => process.cwd(),
		getEntries: () => [],
	},
	ui: { notify: () => {} },
	isProjectTrusted: () => true,
	abort: () => {},
	signal: new AbortController().signal,
	getSystemPrompt: () => "",
};

tinysubagent(api as never);
const tool = tools[0] as {
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
};

// The child's pane is found by diffing the tab's layout against this pane: a
// blocking call returns no details until the whole batch is over, so the ack is
// not available while the child is held.
const orchestratorPaneId = currentPaneId(process.env);
if (!orchestratorPaneId) {
	cleanup();
	fail("not running inside a herdr pane (HERDR_PANE_ID is unset)");
}

/** The one child pane beside the orchestrator. */
async function childPane(): Promise<string | null> {
	const layout = await herdrPaneLayout(orchestratorPaneId!);
	return (layout?.panes.map((pane) => pane.paneId) ?? []).find((id) => id !== orchestratorPaneId) ?? null;
}

async function waitChildPane(): Promise<string> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const found = await childPane();
		if (found) return found;
		await sleep(500);
	}
	cleanup();
	return fail("no child pane appeared beside the orchestrator");
}

let finished = false;
const call = tool.execute(
	"call-1",
	{ tasks: [{ agent: agent.name, task: "Reply with exactly the single word PONG." }] },
	undefined,
	undefined,
	ctx,
).then((result) => {
	finished = true;
	return result;
});

const paneId = await waitChildPane();
console.log(`spawned pane ${paneId} against ${endpoint}`);

// Never leave a live child behind, however this harness dies.
let reaped = false;
function reap(): void {
	if (reaped) return;
	reaped = true;
	try {
		execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore" });
	} catch {
		// Already gone.
	}
}
process.on("exit", reap);

async function paneText(): Promise<string> {
	try {
		const { stdout } = await run("herdr", ["pane", "read", paneId, "--format", "text", "--lines", "80"]);
		return stdout;
	} catch {
		return "";
	}
}

/** Wait until `ready()` is true or the deadline passes. */
async function waitUntil(ready: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await sleep(1_000);
	}
	return ready();
}

/** Every detail line the child reported, for assertions on the returned result. */
function detail(): { outcome?: string; via?: string; reason?: string; summary?: string | null } {
	return ((callResult?.details?.results as { outcome?: string; via?: string; reason?: string }[]) ?? [])[0] ?? {};
}

/** The tool result, once the call has returned. */
let callResult: Awaited<ReturnType<typeof tool.execute>> | null = null;
const raceFinished = () => finished;

/** Hold, then complain if the call returned or the orchestrator heard anything. */
async function hold(ms: number, why: string): Promise<void> {
	console.log(`\n── holding ${ms / 1000}s ${why} ──`);
	await sleep(ms);
	if (raceFinished()) {
		callResult = await call;
		assert.fail(`the blocking call returned ${why}: ${callResult.content[0]?.text ?? ""}`);
	}
	if (sent.length !== 0) {
		fail(
			`the orchestrator was messaged ${why} — that is not an ending.\n\n` +
				sent.map((entry) => entry.message.content).join("\n\n"),
		);
	}
	const alive = await herdrPaneExists(paneId);
	console.log(`no message after ${ms / 1000}s; child pane still open: ${alive}`);
	if (alive !== true) fail(`the child pane closed ${why} — the human cannot fix and drive it`);
}

if (noAuth) {
	// ── The refused shape: a prompt pi will not start holds the pane ─────────
	// The child has no usable credentials, so pi refuses the prompt before any
	// run starts. Nothing may reach the orchestrator: a refusal is not an ending,
	// and the pane is where the human runs /login and drives the child on.
	await hold(15_000, "with no usable credentials");

	// Pin the shape itself, not just the silence: pi refused the prompt before
	// any run started. The refusal is word-wrapped to the pane width, so match
	// its stable words rather than one line.
	const heldText = await paneText();
	const refused = /no api key/i.test(heldText) && heldText.includes("oc-openai");
	console.log(`child pane shows pi's refusal: ${refused}`);
	if (!refused) fail(`the child did not refuse the prompt as expected:\n${heldText}`);

	// No run ever begins, so no report is ever written. What ends the call is
	// whichever non-report ending the refusal leaves behind: a child that stays at
	// its prompt is bounded by the never-started grace, while a child pi that quits
	// writes a clean exit code. Either way nothing was reported, and the reader must
	// be told that rather than handed the refusal scraped back as a summary.
	console.log("\n── waiting for the refusal to end the call ──");
	callResult = await call;
	const text = callResult.content[0]?.text ?? "";
	const outcome = detail();
	const neverStarted = outcome.outcome === "failed" && outcome.reason === "never-started";
	const exited = outcome.outcome === "completed" && outcome.via === "session-exit";
	console.log(
		`the refusal ended the call as ${outcome.outcome}` +
			`${outcome.via ? ` (${outcome.via})` : ""}${outcome.reason ? ` (${outcome.reason})` : ""}`,
	);
	assert.ok(neverStarted || exited, `the refusal was reported as neither never-started nor an exit:\n${text}`);
	assert.equal(sent.length, 0, `the orchestrator was messaged after the refusal:\n${text}`);
	// A never-started failure names itself and points at the pane it kept; a clean
	// exit has to say the child never reported, instead of quoting the refusal back
	// as if the child had handed it over.
	if (neverStarted) {
		assert.match(text, /failed \(never-started\)/, `the failure went unnamed:\n${text}`);
		assert.match(text, new RegExp(`inspect pane \`?${paneId}`), `the open pane was not named:\n${text}`);
	} else {
		assert.match(text, /never reported/, `the summary-less ending went unexplained:\n${text}`);
	}
	assert.doesNotMatch(text, /completed \(reported\)/, `the refusal was reported as a report:\n${text}`);
	console.log("\n── result text ──\n" + text);

	// A never-started failure is the fixable case: the pane is where the human runs
	// /login, so it must still be there. A session exit left no pane behind.
	if (neverStarted) {
		const stillOpen = await herdrPaneExists(paneId);
		console.log(`refused child's pane still open after the failure: ${stillOpen}`);
		if (stillOpen !== true) {
			reap();
			cleanup();
			fail("a never-started failure closed the pane the human needs to log in on");
		}
	}

	cleanup();
	reap();
	console.log("\nPASS a refused prompt held silently, then failed as never-started with its pane left open");
	process.exit(0);
}

// ── The provider-outage shape ───────────────────────────────────────────────
// Wait for the child to actually hit the outage before starting the hold clock.
const sawError = await waitUntil(async () => /503|service unavailable|error/i.test(await paneText()), 60_000);
console.log(
	sawError
		? "child pane shows the provider error"
		: "child pane did not show the error yet; holding anyway",
);

await hold(retries ? 25_000 : 15_000, "with the endpoint down");

// ── Recovery: healthy endpoint, human drives the same child to report ───────
healthy = true;
console.log("\n── endpoint healthy; driving the held child to subagent_report ──");
await run("herdr", [
	"pane",
	"run",
	paneId,
	"The provider is fixed. Call subagent_report now with the single word PONG.",
]);

console.log("waiting for the call to return the report...");
callResult = await call;
const body = callResult.content[0]?.text ?? "";
assert.equal(detail().outcome, "completed", `expected a completion:\n${body}`);
assert.equal(detail().via, "report", `the report was read as a settle, not the child's hand-back:\n${body}`);
assert.ok(body.includes("completed (reported)"), `expected \`completed (reported)\`:\n${body}`);
assert.ok(body.includes("PONG"), `the child's answer is missing from the report:\n${body}`);
assert.equal(sent.length, 0, `the orchestrator was messaged although the result is the tool result:\n${body}`);
console.log("\n── result text ──\n" + body);

// The report is what ends the child: the pane must not outlive it.
const closed = await waitUntil(async () => (await herdrPaneExists(paneId)) === false, 15_000);
console.log(`child pane closed after the report: ${closed}`);
if (!closed) {
	reap();
	cleanup();
	fail("the child reported but its pane stayed open");
}

cleanup();
console.log("\nPASS a provider error held silently and the later report came back as the tool result");
process.exit(0);
