/**
 * Provider-error smoke test: a child whose model endpoint fails must be reported
 * to the orchestrator as `failed (error)`, not silently swallowed.
 *
 * The distinction this pins down is the whole point of the interrupt rule: an Esc
 * is *not* a failure and must tell the orchestrator nothing, while a genuine
 * provider error (503, bad model, auth) must still come back. The two are easy to
 * conflate because pi labels a tool-call Esc as a plain `error` too.
 *
 * It drives a real child in a real pane against a local HTTP server that always
 * answers 503, so no external provider is involved and the failure is exact.
 *
 * Usage: node scripts/smoke-provider-error.ts [agent] [--retries] [--no-auth]
 *
 * `--retries` keeps pi's automatic retry on, so the 503 has to survive the
 * retry-and-give-up path — the path a real provider outage actually takes, and
 * the one most likely to lose the report. Both shapes must end the same way.
 *
 * `--no-auth` drops the child's credentials instead, which makes pi refuse the
 * prompt before any run starts. That is the other kind of "the subagent errored":
 * no agent phase, so no settle, so nothing is written unless the child notices
 * on its own.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import tinysubagent from "../index.ts";
import { discoverAgents } from "../src/config/agents.ts";
import { herdrPaneClose, herdrPaneExists, herdrPluginInfo, PLUGIN_ID } from "../src/herdr/cli.ts";
import { TOOL_NAME } from "../src/children/spawn.ts";

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

// ── The 503 endpoint ────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
	res.writeHead(503, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: "Service Unavailable (smoke)", type: "server_error" } }));
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
// on means it has to exhaust its backoff first. Either way the child must report.
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
let steerResolve: (() => void) | null = null;
const steered = new Promise<void>((resolve) => {
	steerResolve = resolve;
});

const api = {
	on() {},
	registerTool(tool: Record<string, unknown>) {
		tools.push(tool);
	},
	sendMessage(message: { content: string }, options: unknown) {
		sent.push({ message, options });
		steerResolve?.();
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

/** A refusal settles in the child's first second; a 503 has retries to exhaust. */
const timeoutMs = noAuth ? 90_000 : 120_000;

const timeout = setTimeout(
	() => {
		reap();
		cleanup();
		fail(
			`timed out after ${timeoutMs / 1000}s: ` +
				(noAuth
					? "pi refused the run and the orchestrator was never told — the batch hangs here."
					: "a provider 503 was never reported to the orchestrator.") +
				"\nThis is the bug — an error that is not an interrupt must reach the parent.",
		);
	},
	timeoutMs,
);
await steered;
clearTimeout(timeout);

console.log(`\n── steer message ──\n${sent.map((entry) => entry.message.content).join("\n\n")}`);
const body = sent.map((entry) => entry.message.content).join("\n");
assert.equal(sent.length, 1, `expected one steer message, got ${sent.length}`);
assert.ok(body.includes("failed (error)"), `expected \`failed (error)\`:\n${body}`);
if (noAuth) {
	// pi never started the run, so there is no turn to scrape a reason out of: the
	// report itself has to carry it, or the orchestrator sees a bare "failed".
	assert.ok(
		body.includes("no API key") && body.includes("/login oc-openai"),
		`the refusal reason is missing from the report:\n${body}`,
	);
} else {
	assert.ok(body.includes("503"), `the provider's 503 reason is missing:\n${body}`);
}

// A failed child's pane stays open so the error is readable — reap it here.
const alive = await herdrPaneExists(paneId);
console.log(`child pane still open: ${alive}`);
reap();
process.env.PI_HERDR_LAUNCH_PREFIX = previousPrefix;
cleanup();
console.log("\nPASS a provider error reached the orchestrator as a failure");
process.exit(0);
