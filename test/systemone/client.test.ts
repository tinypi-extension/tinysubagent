import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	DEFAULT_SYSTEMONE_BASE_URL,
	MAX_RESPONSE_BYTES,
	SYSTEMONE_MODEL,
	SYSTEMONE_TIMEOUT_MS,
	normalizeBaseUrl,
	routeOnce,
} from "../../src/systemone/client.ts";

/** Fake fetch that records the call and answers from a fixed response template. */
function fakeFetch(
	response: { status: number; body?: string },
	calls: { url: string; init: RequestInit }[],
): typeof fetch {
	const fn = async (url: unknown, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init: init ?? {} });
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			arrayBuffer: async () =>
				new TextEncoder().encode(response.body ?? "").buffer as ArrayBuffer,
		} as unknown as Response;
	};
	return fn as unknown as typeof fetch;
}

const baseInput = {
	apiKey: "sk-test-DEADBEEF",
	baseUrl: "https://api.typesafe.ai",
	task: "summarise the changelog",
	role: { name: "worker", description: "does the work" },
	criteria: {
		light: "model cc/deepseek/deepseek-v4.1-flash, thinking low",
		pro: "model cc/z-ai/glm-5.3-flash, thinking high",
	},
};

const validAnswer = {
	answers: {
		profile: {
			type: "choice",
			choice: "pro",
			confidence: 0.87,
			probabilities: { light: 0.13, pro: 0.87 },
		},
	},
};

test("constants match the wire contract", () => {
	assert.equal(SYSTEMONE_MODEL, "jev-latest");
	assert.equal(DEFAULT_SYSTEMONE_BASE_URL, "https://api.typesafe.ai");
	assert.equal(SYSTEMONE_TIMEOUT_MS, 2000);
	assert.equal(MAX_RESPONSE_BYTES, 1_000_000);
});

test("normalizeBaseUrl: table", () => {
	const table: [string, string | null][] = [
		["https://api.typesafe.ai/", "https://api.typesafe.ai"],
		["https://api.typesafe.ai/v1", "https://api.typesafe.ai"],
		["https://api.typesafe.ai/systemone", "https://api.typesafe.ai"],
		["https://api.typesafe.ai/v1/systemone/", "https://api.typesafe.ai"],
		["http://localhost:8080/v1/", "http://localhost:8080"],
		["http://127.0.0.1", "http://127.0.0.1"],
		["  https://api.typesafe.ai/v1  ", "https://api.typesafe.ai"],
		["http://api.typesafe.ai", null],
		["ftp://x", null],
		["not a url", null],
		["", null],
	];
	for (const [raw, expected] of table) {
		assert.equal(normalizeBaseUrl(raw), expected, `input: ${JSON.stringify(raw)}`);
	}
});

test("success 200: parses choice + confidence, request is exactly the wire contract", async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const result = await routeOnce(baseInput, { fetch: fakeFetch({ status: 200, body: JSON.stringify(validAnswer) }, calls) });

	assert.deepEqual(result, { choice: "pro", confidence: 0.87 });
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.ok(call);
	const { url, init } = call;
	assert.equal(url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(init.method, "POST");
	assert.equal(init.redirect, "manual");
	// Headers verbatim — the auth header shape is the whole point of the credential rule.
	assert.deepEqual(init.headers, {
		"content-type": "application/json",
		authorization: "Bearer sk-test-DEADBEEF",
	});
	// The body matches the spec example, given the same inputs.
	assert.deepEqual(JSON.parse(String(init.body)), {
		model: "jev-latest",
		state: {
			role: { name: "worker", description: "does the work" },
			task: "summarise the changelog",
		},
		questions: {
			profile: {
				type: "choice",
				instructions:
					"Which model/thinking profile should run this task? Choose the cheapest profile that can do it well, weighing how much reasoning and tool use it needs.",
				criteria: baseInput.criteria,
			},
		},
	});
});

test("every failure row maps to null", async () => {
	const failureRows: { name: string; status?: number; body?: string }[] = [
		{ name: "401", status: 401, body: '{"error":"bad key"}' },
		{ name: "429", status: 429, body: '{"error":"rate limited"}' },
		{ name: "500", status: 500, body: "boom" },
		{ name: "422", status: 422, body: '{"error":"validation"}' },
		{ name: "302 redirect not followed", status: 302, body: "" },
		{ name: "non-JSON body", status: 200, body: "<html>nope</html>" },
		{ name: "answers.profile missing", status: 200, body: JSON.stringify({ answers: {} }) },
		{ name: "type not choice", status: 200, body: JSON.stringify({ answers: { profile: { type: "score", choice: "pro", probabilities: { pro: 1 } } } }) },
		{ name: "choice not a string", status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: 7, probabilities: { "7": 1 } } } }) },
		{ name: "choice absent from probabilities", status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: { light: 1 } } } }) },
		{ name: "probabilities missing", status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro" } } }) },
		{ name: "probabilities not an object", status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: [1] } } }) },
		{ name: "body larger than 1 MB", status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: { pro: 1 } } }, pad: "x".repeat(MAX_RESPONSE_BYTES + 1) }) },
	];

	for (const row of failureRows) {
		const calls: { url: string; init: RequestInit }[] = [];
		const result = await routeOnce(baseInput, { fetch: fakeFetch({ status: row.status ?? 200, body: row.body }, calls) });
		assert.equal(result, null, `row: ${row.name}`);
		assert.equal(calls.length, 1, `row: ${row.name} should have made exactly one attempt`);
	}
});

test("already-aborted input signal: null with zero fetch calls", async () => {
	let calls = 0;
	const doFetch: typeof fetch = (async () => {
		calls += 1;
		throw new Error("fetch must not be reached");
	}) as unknown as typeof fetch;
	const controller = new AbortController();
	controller.abort();

	const result = await routeOnce({ ...baseInput, signal: controller.signal }, { fetch: doFetch });
	assert.equal(result, null);
	assert.equal(calls, 0);
});

test("timeout aborts a pending BODY read, not just the headers", async () => {
	const slowBodyFetch = ((url: unknown, init?: RequestInit) => {
		const signal = (init as RequestInit & { signal: AbortSignal }).signal;
		assert.ok(signal, "the controller signal must reach the fetch call");
		return {
			ok: true,
			status: 200,
			// Only rejects on abort — the timer, not the headers, must end this.
			arrayBuffer: () =>
				new Promise<ArrayBuffer>((_, reject) => {
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				}),
		} as unknown as Response;
	}) as unknown as typeof fetch;

	const started = performance.now();
	const result = await routeOnce(baseInput, { fetch: slowBodyFetch, timeoutMs: 20 });
	const elapsed = performance.now() - started;

	assert.equal(result, null);
	assert.ok(elapsed < 1000, `took ${elapsed}ms — the body read was not aborted by the timer`);
});

test("a throwing fetch maps to null", async () => {
	const throwing: typeof fetch = (() => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	assert.equal(await routeOnce(baseInput, { fetch: throwing }), null);
});

test("non-function fetch maps to null", async () => {
	// Must be a non-nullish non-function: `undefined`/`null` would hit the `??`
	// fallback and dial the real endpoint.
	const result = await routeOnce(baseInput, { fetch: 42 as unknown as typeof fetch });
	assert.equal(result, null);
});

test("redaction: the key and base URL appear in no failure row's returned string", async () => {
	// Every way routeOnce can fail must map to a bare null: no row may carry the
	// credential or the endpoint back to the caller.
	const key = "sk-test-DEADBEEF";
	const baseUrl = "https://api.typesafe.ai";
	const input = { ...baseInput, apiKey: key, baseUrl };

	// A body that never fulfills on its own — only the client's abort ends it.
	const hangingBodyFetch = ((_url: unknown, init?: RequestInit) => {
		const signal = (init as RequestInit & { signal: AbortSignal }).signal;
		return {
			ok: true,
			status: 200,
			arrayBuffer: () =>
				new Promise<ArrayBuffer>((_, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				}),
		} as unknown as Response;
	}) as unknown as typeof fetch;

	const throwing: typeof fetch = (() => {
		throw new Error("network down");
	}) as unknown as typeof fetch;

	const rows: { name: string; run: () => Promise<unknown> }[] = [
		{ name: "401", run: () => routeOnce(input, { fetch: fakeFetch({ status: 401, body: '{"error":"unauthorized"}' }, []) }) },
		{ name: "429", run: () => routeOnce(input, { fetch: fakeFetch({ status: 429, body: '{"error":"rate limited"}' }, []) }) },
		{ name: "500", run: () => routeOnce(input, { fetch: fakeFetch({ status: 500, body: "boom" }, []) }) },
		{ name: "422", run: () => routeOnce(input, { fetch: fakeFetch({ status: 422, body: '{"error":"validation"}' }, []) }) },
		{ name: "302 redirect not followed", run: () => routeOnce(input, { fetch: fakeFetch({ status: 302, body: "" }, []) }) },
		{ name: "non-JSON body", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: "<html>nope</html>" }, []) }) },
		{ name: "answers.profile missing", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: {} }) }, []) }) },
		{ name: "type not choice", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "score", choice: "pro", probabilities: { pro: 1 } } } }) }, []) }) },
		{ name: "choice not a string", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: 7, probabilities: { "7": 1 } } } }) }, []) }) },
		{ name: "choice absent from probabilities", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: { light: 1 } } } }) }, []) }) },
		{ name: "probabilities missing", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro" } } }) }, []) }) },
		{ name: "probabilities not an object", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: [1] } } }) }, []) }) },
		{ name: "body larger than 1 MB", run: () => routeOnce(input, { fetch: fakeFetch({ status: 200, body: JSON.stringify({ answers: { profile: { type: "choice", choice: "pro", probabilities: { pro: 1 } } }, pad: "x".repeat(MAX_RESPONSE_BYTES + 1) }) }, []) }) },
		{ name: "throwing fetch", run: () => routeOnce(input, { fetch: throwing }) },
		{
			name: "already-aborted signal",
			run: () => {
				const controller = new AbortController();
				controller.abort();
				return routeOnce({ ...input, signal: controller.signal }, { fetch: throwing });
			},
		},
		{ name: "never-resolving body", run: () => routeOnce(input, { fetch: hangingBodyFetch, timeoutMs: 20 }) },
	];

	for (const row of rows) {
		const result = await row.run();
		const rendered = JSON.stringify(result);
		assert.equal(result, null, `row ${row.name} should fall back to null`);
		assert.ok(!rendered.includes(key), `row ${row.name}: the key leaked into ${rendered}`);
		assert.ok(!rendered.includes(baseUrl), `row ${row.name}: the base URL leaked into ${rendered}`);
	}
});
