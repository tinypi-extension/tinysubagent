/**
 * The live view of a running batch: one line per child, redrawn on a cadence.
 *
 * No child and no terminal appears here. The clock and the ticker are injected,
 * so a redraw is something the test asks for rather than something it waits
 * out, and every assertion is about what a view says and when it was drawn —
 * never about the constant that spaces the draws.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	createLiveLines,
	type LiveChild,
	type LiveTicker,
} from "../../src/pi/live-lines.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

/** A ticker the test drives by hand: no sleep decides when a redraw happens. */
function manualTicker(): { every: LiveTicker; fire: () => void; stopped: () => number } {
	const ticks: (() => void)[] = [];
	let stopped = 0;
	return {
		every: (_ms, tick) => {
			ticks.push(tick);
			return () => {
				stopped += 1;
			};
		},
		fire: () => {
			for (const tick of [...ticks]) tick();
		},
		stopped: () => stopped,
	};
}

function worker(name: string, overrides: Partial<LiveChild> = {}): LiveChild {
	return {
		agent: "worker",
		name,
		profile: { name: "current" },
		startedAt: 0,
		...overrides,
	};
}

/** One `message_update` record carrying an assistant text delta, as pi frames it. */
function textDelta(delta: string): string {
	return `${JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	})}\n`;
}

function assistantEvent(type: string, delta: string): string {
	return `${JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type, contentIndex: 0, delta },
	})}\n`;
}

// ────────────────────────────────────────────────────────────────────────────
// The cadence
// ────────────────────────────────────────────────────────────────────────────

test("several chunks between two ticks are one redraw, and only the last line survives", () => {
	const ticker = manualTicker();
	const views: string[][] = [];
	const live = createLiveLines([worker("one"), worker("two")], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => 0,
	});

	live.start();
	// The spawn is acknowledged at once: a wait follows, and the ack opens the line.
	assert.equal(views.length, 1);
	assert.equal(views[0]?.length, 2);
	assert.equal(views[0]?.[0], "Worker (one) [current] · 0s");
	assert.equal(views[0]?.[1], "Worker (two) [current] · 0s");

	// Draining never draws: three deltas in a row change no view on their own.
	live.reader(0)(textDelta("first\n"));
	live.reader(0)(textDelta("second\n"));
	live.reader(0)(textDelta("third"));
	assert.equal(views.length, 1, "a chunk redrew the view");

	ticker.fire();
	assert.equal(views.length, 2, "one tick drew more than one view");
	assert.equal(views[1]?.[0], "Worker (one) [current] · 0s · third");
	assert.equal(views[1]?.[1], "Worker (two) [current] · 0s");

	// The earlier lines are gone, not scrolled above the last one.
	live.reader(0)(textDelta(" fourth"));
	ticker.fire();
	const latest = views.at(-1) ?? [];
	assert.equal(latest[0], "Worker (one) [current] · 0s · third fourth");
	assert.doesNotMatch(latest[0] ?? "", /first|second/);
});

test("a record split across two chunks is still one delta", () => {
	const ticker = manualTicker();
	const views: string[][] = [];
	const live = createLiveLines([worker("one")], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => 0,
	});

	const record = textDelta("split record");
	live.start();
	live.reader(0)(record.slice(0, 12));
	ticker.fire();
	assert.equal(views.at(-1)?.[0], "Worker (one) [current] · 0s");
	live.reader(0)(record.slice(12));
	ticker.fire();
	assert.equal(views.at(-1)?.[0], "Worker (one) [current] · 0s · split record");
});

test("thinking and tool-call deltas are not the child's words", () => {
	const ticker = manualTicker();
	const views: string[][] = [];
	const live = createLiveLines([worker("one")], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => 0,
	});

	live.start();
	live.reader(0)(assistantEvent("thinking_delta", "a private thought"));
	live.reader(0)(assistantEvent("toolcall_delta", '{"path":"secret"}'));
	ticker.fire();
	assert.equal(views.at(-1)?.[0], "Worker (one) [current] · 0s");
});

test("elapsed time is read from the spawn, so a quiet child still shows it moving", () => {
	const ticker = manualTicker();
	let now = 0;
	const views: string[][] = [];
	const live = createLiveLines([worker("one", { startedAt: 0 })], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => now,
	});

	live.start();
	assert.equal(views[0]?.[0], "Worker (one) [current] · 0s");
	now = 3_000;
	ticker.fire();
	assert.equal(views.at(-1)?.[0], "Worker (one) [current] · 3s");
});

test("clearing stops the cadence and reports an empty view", () => {
	const ticker = manualTicker();
	const views: string[][] = [];
	const live = createLiveLines([worker("one")], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => 0,
	});

	live.start();
	live.reader(0)(textDelta("work in progress"));
	ticker.fire();
	assert.match(views.at(-1)?.[0] ?? "", /work in progress/);

	live.clear();
	assert.deepEqual(views.at(-1), [], "the live view was not cleared");
	assert.equal(ticker.stopped(), 1);

	const drawn = views.length;
	ticker.fire();
	assert.equal(views.length, drawn, "a redraw outlived the clear");
});

test("a batch of no children draws nothing at all", () => {
	const ticker = manualTicker();
	const views: string[][] = [];
	const live = createLiveLines([], {
		onLines: (lines) => views.push([...lines]),
		every: ticker.every,
		now: () => 0,
	});

	live.start();
	ticker.fire();
	assert.deepEqual(views, []);
});
