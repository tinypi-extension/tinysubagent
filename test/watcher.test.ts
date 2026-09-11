import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunningSubagent } from "../src/watcher.ts";
import { waitForSubagent } from "../src/watcher.ts";

/**
 * A watcher run with every path pointed at a temp directory, plus a liveness
 * probe stub. Tests drive the classification matrix by writing exactly the
 * sidecars a real child would write.
 */
function scenario(options: { session?: string | null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-watch-"));
	const sessionFile = join(dir, "session.jsonl");
	const session = options.session === undefined ? "the answer" : options.session;
	if (session !== null) {
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: session }] },
			})}\n`,
			"utf8",
		);
	}

	const running: RunningSubagent = {
		id: "aaaa1111",
		name: "watch",
		agent: "worker",
		profile: { name: "light" },
		paneId: "w1:p9",
		sessionFile,
		exitCodeFile: `${sessionFile}.exitcode`,
		reportFile: `${sessionFile}.done`,
		startedAt: Date.now(),
		task: "do the thing",
	};

	const probes: string[] = [];
	return {
		running,
		dir,
		probes,
		/** 10ms polling keeps the matrix fast without changing behaviour. */
		deps: {
			pollIntervalMs: 10,
			paneExists: async (paneId: string) => {
				probes.push(paneId);
				return true;
			},
		},
		write(file: string, content: string) {
			writeFileSync(file, content, "utf8");
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a done report completes the run and consumes both sidecars", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"done"}');
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.deepEqual(outcome, { kind: "completed", via: "turn-end", summary: "the answer" });
		// Consumed, so a later run on the same session path cannot read them twice.
		assert.equal(existsSync(s.running.reportFile), false);
	} finally {
		s.cleanup();
	}
});

test("a failed report is a failure and keeps its error reason", async () => {
	const s = scenario({ session: null });
	try {
		s.write(
			s.running.sessionFile,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "401: model is not supported",
				},
			})}\n`,
		);
		s.write(s.running.reportFile, '{"type":"failed","reason":"error"}');
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.kind === "failed" && outcome.reason, "error");
		// No exit code: the child is still alive, holding its pane open for the user.
		assert.equal(outcome.kind === "failed" && outcome.exitCode, null);
		assert.equal(outcome.summary, "401: model is not supported");
	} finally {
		s.cleanup();
	}
});

test("a failed report with no turn behind it carries its own reason", async () => {
	const s = scenario({ session: null });
	try {
		// pi refused to start the run — no API key — so it never wrote a turn and
		// the session has nothing to explain the failure with. The report's own
		// message is the only thing standing between the orchestrator and a bare
		// "failed", which is why it is plumbed through as the summary.
		s.write(
			s.running.reportFile,
			JSON.stringify({
				type: "failed",
				reason: "error",
				message: 'no API key configured for "oc-openai" — run /login oc-openai.',
			}),
		);
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.kind === "failed" && outcome.reason, "error");
		assert.equal(outcome.summary, 'no API key configured for "oc-openai" — run /login oc-openai.');
	} finally {
		s.cleanup();
	}
});

test("a report's own message outranks the session's older failure note", async () => {
	const s = scenario({ session: null });
	try {
		// The turn that failed is stale: the user retried, and the refusal that
		// followed is what the orchestrator needs to know about.
		s.write(
			s.running.sessionFile,
			`${JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "old failure" },
			})}\n`,
		);
		s.write(
			s.running.reportFile,
			'{"type":"failed","reason":"error","message":"new failure"}',
		);
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.summary, "new failure");
	} finally {
		s.cleanup();
	}
});

test("a report's own message outranks stale text from an earlier turn", async () => {
	const s = scenario({ session: "I got as far as the migration" });
	try {
		// The user Esc'd that turn and then retyped it into a run pi refused. The
		// session text is real, but it is not *this* run's ending — reporting it would
		// hide the reason the batch stopped, which is the entire point of the report.
		s.write(
			s.running.reportFile,
			JSON.stringify({
				type: "failed",
				reason: "error",
				message: 'no API key configured for "oc-openai"',
			}),
		);
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.summary, 'no API key configured for "oc-openai"');
	} finally {
		s.cleanup();
	}
});

test("a failed report that is not a usable message is read as one without", async () => {
	// `message` comes from a file another process wrote, so a reader that trusted its
	// shape would be trusting whatever is on disk.
	for (const message of ["   ", 42, { why: "no" }, null]) {
		const s = scenario({ session: null });
		try {
			s.write(
				s.running.reportFile,
				JSON.stringify({ type: "failed", reason: "error", message }),
			);
			const outcome = await waitForSubagent(s.running, undefined, s.deps);
			assert.equal(outcome.kind, "failed");
			assert.equal(outcome.summary, null, `expected no summary for ${JSON.stringify(message)}`);
		} finally {
			s.cleanup();
		}
	}
});

test("an over-long report message is clipped, not dropped", async () => {
	const s = scenario({ session: null });
	try {
		s.write(
			s.running.reportFile,
			JSON.stringify({ type: "failed", reason: "error", message: "x".repeat(1_200) }),
		);
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.summary?.length, 1_000);
		assert.ok(outcome.summary?.endsWith("…"));
	} finally {
		s.cleanup();
	}
});

test("an aborted report does not settle the batch while the child is alive", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"failed","reason":"aborted"}');

		// The user interrupted this child to redirect it; it is back at its prompt. The
		// report is stale the moment it lands, so it must neither end the wait nor be
		// re-read on the next tick.
		const pending = waitForSubagent(s.running, undefined, s.deps);
		const raced = await Promise.race([
			pending.then(() => "settled"),
			new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 120)),
		]);
		assert.equal(raced, "waiting");
		assert.equal(existsSync(s.running.reportFile), false);

		// The redirect was typed and the child finished for real. That does end it —
		// the same watcher must still be watching the same pane.
		s.write(s.running.reportFile, '{"type":"done"}');
		assert.deepEqual(await pending, {
			kind: "completed",
			via: "turn-end",
			summary: "the answer",
		});
	} finally {
		s.cleanup();
	}
});

test("an unknown failure reason degrades to error rather than being trusted", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"failed","reason":"something-new"}');
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.kind === "failed" && outcome.reason, "error");
	} finally {
		s.cleanup();
	}
});

test("a report carrying a result beats a contradicting session file", async () => {
	const s = scenario();
	try {
		// The session says "the answer"; the report says otherwise. The report is
		// the child's explicit hand-back, so it wins.
		s.write(
			s.running.reportFile,
			JSON.stringify({ type: "done", result: "the reported result" }),
		);
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.deepEqual(outcome, {
			kind: "completed",
			via: "report",
			summary: "the reported result",
		});
	} finally {
		s.cleanup();
	}
});

test("a report with an empty result falls back to the session text", async () => {
	const s = scenario();
	try {
		// An empty payload is no payload: fall back to the legacy scrape rather
		// than delivering a blank result.
		s.write(s.running.reportFile, JSON.stringify({ type: "done", result: "" }));
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.deepEqual(outcome, { kind: "completed", via: "turn-end", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("a report whose result is not a string falls back to the session text", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, JSON.stringify({ type: "done", result: { text: "nope" } }));
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.deepEqual(outcome, { kind: "completed", via: "turn-end", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("a malformed report still counts as settled, with the text from the session", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"do');
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		// A report exists, so the child finished; the answer is read from the log.
		assert.deepEqual(outcome, { kind: "completed", via: "turn-end", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("a clean exit with no report is a completion, since the work still happened", async () => {
	const s = scenario();
	try {
		s.write(s.running.exitCodeFile, "0 aaaa1111\n");
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.deepEqual(outcome, { kind: "completed", via: "session-exit", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("a non-zero exit with no report is an exit failure carrying the code", async () => {
	const s = scenario();
	try {
		s.write(s.running.exitCodeFile, "3 aaaa1111\n");
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		assert.equal(outcome.kind, "failed");
		assert.equal(outcome.kind === "failed" && outcome.reason, "exit");
		assert.equal(outcome.kind === "failed" && outcome.exitCode, 3);
		assert.equal(outcome.summary, "the answer");
	} finally {
		s.cleanup();
	}
});

test("a failed report outranks a later non-zero exit code", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"failed","reason":"error"}');
		s.write(s.running.exitCodeFile, "1 aaaa1111\n");
		const outcome = await waitForSubagent(s.running, undefined, s.deps);
		// The child's own account of how it ended is the more specific truth.
		assert.equal(outcome.kind === "failed" && outcome.reason, "error");
		assert.equal(outcome.kind === "failed" && outcome.exitCode, null);
	} finally {
		s.cleanup();
	}
});

test("an exit code stamped with another run's id is ignored, not credited", async () => {
	const s = scenario();
	try {
		// A stale sidecar from a previous run that reused this session path.
		s.write(s.running.exitCodeFile, "1 deadbeef\n");
		const pending = waitForSubagent(s.running, undefined, s.deps);
		await new Promise((resolve) => setTimeout(resolve, 60));
		// Still waiting: the stale file was consumed and the watcher kept polling.
		assert.equal(existsSync(s.running.exitCodeFile), false);
		s.write(s.running.reportFile, '{"type":"done"}');
		const outcome = await pending;
		assert.deepEqual(outcome, { kind: "completed", via: "turn-end", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("a vanished pane with no signal is a cancellation, not a hang", async () => {
	const s = scenario();
	try {
		const outcome = await waitForSubagent(s.running, undefined, {
			pollIntervalMs: 5,
			paneExists: async () => false,
		});
		assert.deepEqual(outcome, { kind: "cancelled", summary: "the answer" });
	} finally {
		s.cleanup();
	}
});

test("an unknown pane answer is not treated as death", async () => {
	const s = scenario();
	try {
		// `null` means the probe could not tell; the wait must continue, so the
		// real answer is what ends it.
		const pending = waitForSubagent(s.running, undefined, {
			pollIntervalMs: 5,
			paneExists: async () => null,
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		s.write(s.running.reportFile, '{"type":"done"}');
		const outcome = await pending;
		assert.equal(outcome.kind, "completed");
	} finally {
		s.cleanup();
	}
});

test("aborting resolves the wait instead of leaving it open", async () => {
	const s = scenario();
	try {
		const controller = new AbortController();
		const pending = waitForSubagent(s.running, controller.signal, s.deps);
		controller.abort();
		const outcome = await pending;
		assert.equal(outcome.kind, "cancelled");
	} finally {
		s.cleanup();
	}
});

test("an already-aborted signal resolves immediately", async () => {
	const s = scenario();
	try {
		const controller = new AbortController();
		controller.abort();
		const outcome = await waitForSubagent(s.running, controller.signal, s.deps);
		assert.equal(outcome.kind, "cancelled");
	} finally {
		s.cleanup();
	}
});

test("a done report wins even when the pane has already gone", async () => {
	const s = scenario();
	try {
		s.write(s.running.reportFile, '{"type":"done"}');
		const outcome = await waitForSubagent(s.running, undefined, {
			pollIntervalMs: 5,
			paneExists: async () => false,
		});
		// Timing: whichever lands first, the report must not be lost as a cancel.
		assert.equal(outcome.kind, "completed");
	} finally {
		s.cleanup();
	}
});

test("the liveness probe is polled, not called every tick", async () => {
	const s = scenario();
	try {
		let calls = 0;
		const pending = waitForSubagent(s.running, undefined, {
			pollIntervalMs: 5,
			paneExists: async () => {
				calls += 1;
				return null;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		s.write(s.running.reportFile, '{"type":"done"}');
		await pending;
		// Roughly one probe per five ticks; generously bounded so this cannot flake.
		assert.ok(calls >= 1 && calls <= 6, `expected 1-6 probes, saw ${calls}`);
	} finally {
		s.cleanup();
	}
});
