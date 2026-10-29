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
 * orchestrator while the pane is open, and closing that pane by hand is what
 * ends the batch — as `cancelled`.
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
import { herdrPaneExists, herdrPluginInfo, PLUGIN_ID } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/children/spawn.ts";

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

const ack = await tool.execute(
	"call-1",
	{ agent: agent.name, task: "Reply with exactly the single word PONG." },
	undefined,
	undefined,
	ctx,
);
const paneId = (ack.details.spawned as { paneId: string }[] | undefined)?.[0]?.paneId;
if (!paneId) {
	process.env.PI_HERDR_LAUNCH_PREFIX = previousPrefix;
	cleanup();
	fail(`nothing was spawned: ${JSON.stringify(ack.details)}`);
}
console.log(`spawned pane ${paneId} against ${endpoint}`);
console.log(ack.content[0]?.text ?? "(no ack text)");

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

const bodyText = () => sent.map((entry) => entry.message.content).join("\n\n");

if (noAuth) {
	// ── The refused shape: a prompt pi will not start holds the pane ─────────
	// The child has no usable credentials, so pi refuses the prompt before any
	// run starts. Nothing may reach the orchestrator: a refusal is not an ending,
	// and the pane is where the human runs /login and drives the child on.
	const holdMs = 15_000;
	console.log(`\n── holding ${holdMs / 1000}s with no usable credentials ──`);
	await sleep(holdMs);

	if (sent.length !== 0) {
		fail(
			`the orchestrator was steered for a prompt pi refused — a refusal is not an ending.\n\n${bodyText()}`,
		);
	}
	const heldAlive = await herdrPaneExists(paneId);
	console.log(`no steer after ${holdMs / 1000}s; child pane still open: ${heldAlive}`);
	if (heldAlive !== true) {
		fail("the child pane closed on a refused prompt — the human cannot log in and retry");
	}
	// Pin the shape itself, not just the silence: pi refused the prompt before
	// any run started. The refusal is word-wrapped to the pane width, so match
	// its stable words rather than one line.
	const heldText = await paneText();
	const refused = /no api key/i.test(heldText) && heldText.includes("oc-openai");
	console.log(`child pane shows pi's refusal: ${refused}`);
	if (!refused) fail(`the child did not refuse the prompt as expected:\n${heldText}`);

	// The human gave up instead: closing the pane is what ends this wait.
	console.log("\n── closing the refused child's pane by hand ──");
	await run("herdr", ["pane", "close", paneId]);

	const cancelled = await waitUntil(() => sent.length > 0, 30_000);
	if (!cancelled) {
		reap();
		cleanup();
		fail("closing the refused child's pane did not end the batch");
	}
	const body = bodyText();
	assert.equal(sent.length, 1, `expected exactly one steer message, got ${sent.length}:\n${body}`);
	assert.ok(
		body.includes("cancelled (pane closed without reporting)"),
		`expected the batch to end cancelled:\n${body}`,
	);
	console.log("\n── steer message ──\n" + body);

	cleanup();
	console.log("\nPASS a refused prompt held silently, and closing the pane ended the batch cancelled");
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

// The hold: nothing may reach the orchestrator, and the child must stay alive.
const holdMs = retries ? 25_000 : 15_000;
console.log(`\n── holding ${holdMs / 1000}s with the endpoint down ──`);
await sleep(holdMs);

if (sent.length !== 0) {
	fail(
		`the orchestrator was steered while the child was held — a provider error is not an ending.\n\n${bodyText()}`,
	);
}
const heldAlive = await herdrPaneExists(paneId);
console.log(`no steer after ${holdMs / 1000}s; child pane still open: ${heldAlive}`);
if (heldAlive !== true) fail("the child pane closed on a provider error — the human cannot fix and drive it");

// ── Recovery: healthy endpoint, human drives the same child to report ───────
healthy = true;
console.log("\n── endpoint healthy; driving the held child to subagent_report ──");
await run("herdr", [
	"pane",
	"run",
	paneId,
	"The provider is fixed. Call subagent_report now with the single word PONG.",
]);

const reported = await waitUntil(() => sent.length > 0, 90_000);
if (!reported) {
	reap();
	cleanup();
	fail("the held child never reported after the provider was fixed — the batch is wedged");
}

const body = bodyText();
assert.equal(sent.length, 1, `expected exactly one steer message, got ${sent.length}:\n${body}`);
assert.ok(body.includes("completed (reported)"), `expected \`completed (reported)\`:\n${body}`);
assert.ok(body.includes("PONG"), `the child's answer is missing from the report:\n${body}`);
console.log("\n── steer message ──\n" + body);

// The report is what ends the child: the pane must not outlive it.
const closed = await waitUntil(async () => (await herdrPaneExists(paneId)) === false, 15_000);
console.log(`child pane closed after the report: ${closed}`);
if (!closed) {
	reap();
	cleanup();
	fail("the child reported but its pane stayed open");
}

cleanup();
console.log("\nPASS a provider error held silently and the later report closed the batch");
process.exit(0);
