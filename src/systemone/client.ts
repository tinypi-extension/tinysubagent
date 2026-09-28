/**
 * Hermetic SystemOne transport: one POST, one attempt, and every failure —
 * network, timeout, non-2xx, a body of the wrong shape — maps to `null` so
 * routing can only ever fall back to `current`, never fail a spawn.
 *
 * Redaction rule: the API key, the base URL, and the word `Bearer` are
 * credentials-and-infrastructure, not diagnostics. No caught error, warning,
 * or returned string ever interpolates them.
 */

/** The model asked for a decision when the config does not name one. */
export const SYSTEMONE_MODEL = "jev-latest";
export const DEFAULT_SYSTEMONE_BASE_URL = "https://api.typesafe.ai";
export const SYSTEMONE_TIMEOUT_MS = 2000;

/** A response body larger than this is not an answer, it is something else — drop it unread. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Trim; require http:/https: (http: only for loopback hosts, so a repo file
 * cannot aim the key at a LAN peer); strip trailing `/`, then any trailing
 * `/v1` or `/systemone`, repeatedly; return null when unusable.
 */
export function normalizeBaseUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	const allowed = url.protocol === "https:" || (url.protocol === "http:" && loopback);
	if (!allowed) return null;
	// Base URLs arrive as the host, or as an API prefix (`…/v1`, `…/systemone`)
	// depending on which doc the user copied. Strip until stable: a round that
	// changes nothing has already left `base` with no trailing `/`, so the loop
	// exits with the answer in hand.
	let base = url.href;
	for (;;) {
		const next = base.replace(/\/$/, "").replace(/\/(v1|systemone)$/, "");
		if (next === base) break;
		base = next;
	}
	return base;
}

export interface RouteOnceInput {
	apiKey: string;
	baseUrl: string; // already normalised
	/** Model to ask; {@link SYSTEMONE_MODEL} when omitted. */
	model?: string;
	task: string;
	role: { name: string; description: string };
	criteria: Record<string, string>;
	signal?: AbortSignal;
}

export interface RouteOnceDeps {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

const CHOICE_INSTRUCTIONS =
	"Which model/thinking profile should run this task? Choose the cheapest profile that can do it well, weighing how much reasoning and tool use it needs.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function routeOnce(
	input: RouteOnceInput,
	deps?: RouteOnceDeps,
): Promise<{ choice: string; confidence: number } | null> {
	// An already-cancelled caller means nobody wants the answer; do not even dial.
	if (input.signal?.aborted) return null;

	const doFetch = deps?.fetch ?? globalThis.fetch;
	if (typeof doFetch !== "function") return null;

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		deps?.timeoutMs ?? SYSTEMONE_TIMEOUT_MS,
	);
	// The caller's abort must end our attempt too — one attempt means one abort source each.
	const onCallerAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onCallerAbort, { once: true });

	const body = JSON.stringify({
		model: input.model ?? SYSTEMONE_MODEL,
		state: {
			role: { name: input.role.name, description: input.role.description },
			task: input.task,
		},
		questions: {
			profile: {
				type: "choice",
				instructions: CHOICE_INSTRUCTIONS,
				criteria: input.criteria,
			},
		},
	});

	try {
		const res = await doFetch(`${input.baseUrl}/v1/systemone`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${input.apiKey}`,
			},
			body,
			// A 302 must come back as a non-ok response, not be followed —
			// the redirect target is not an endpoint we chose to send the brief to.
			redirect: "manual",
			signal: controller.signal,
		});
		if (!res.ok) return null;

		// Read the body under the same signal so the 2 s budget covers the
		// whole exchange, not just the headers.
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_RESPONSE_BYTES) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(buf));
		} catch {
			return null;
		}
		if (!isPlainObject(parsed)) return null;
		const answers = parsed.answers;
		if (!isPlainObject(answers)) return null;
		const profile = answers.profile;
		if (!isPlainObject(profile)) return null;
		if (profile.type !== "choice") return null;
		if (typeof profile.choice !== "string" || profile.choice === "") return null;
		const probabilities = profile.probabilities;
		if (!isPlainObject(probabilities)) return null;
		// An answer without its distribution is an incomplete answer; do not trust it.
		if (!Object.hasOwn(probabilities, profile.choice)) return null;

		const rawConfidence = profile.confidence;
		const confidence =
			typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
				? rawConfidence
				: 0;
		return { choice: profile.choice, confidence };
	} catch {
		// Timeout, abort, DNS, TLS, a throwing fetch — all degrade to `current`
		// silently. Error messages may carry URLs or headers, so they are never surfaced.
		return null;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onCallerAbort);
	}
}
