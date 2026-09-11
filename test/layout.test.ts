import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Rect, TabLayout } from "../src/herdr.ts";
import { LiveSubPanes, planPlacement, planResizes } from "../src/layout.ts";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function box(x: number, y: number, width: number, height: number): Rect {
	return { x, y, width, height };
}

function tab(panes: { paneId: string; rect: Rect }[]): TabLayout {
	return { tabId: "tab-1", panes };
}

const ORCH = "pane-orch";
const NEW = "pane-new";

// ────────────────────────────────────────────────────────────────────────────
// planPlacement — birth vs append, and total behaviour
// ────────────────────────────────────────────────────────────────────────────

test("planPlacement: no live pane in the tab gives the birth placement", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "pane-elsewhere", rect: box(84, 0, 127, 58) },
	]);
	const placement = planPlacement(layout, ORCH, ["pane-closed"]);
	assert.deepEqual(placement, { targetPaneId: ORCH, direction: "right", bornColumn: true });
});

test("planPlacement: empty live list gives the birth placement", () => {
	const layout = tab([{ paneId: ORCH, rect: box(0, 0, 84, 58) }]);
	assert.deepEqual(planPlacement(layout, ORCH, []), {
		targetPaneId: ORCH,
		direction: "right",
		bornColumn: true,
	});
});

test("planPlacement: one live pane appends down to it", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 29) },
		{ paneId: "s2", rect: box(84, 29, 127, 29) },
	]);
	assert.deepEqual(planPlacement(layout, ORCH, ["s1"]), {
		targetPaneId: "s1",
		direction: "down",
		bornColumn: false,
	});
});

test("planPlacement: the bottom-most live pane wins over array order", () => {
	// The array lists the bottom pane first and the top pane last, so a
	// first/last-in-array implementation picks the wrong target. Only rect.y
	// is allowed to decide.
	const layout = tab([
		{ paneId: "s3", rect: box(84, 40, 127, 18) },
		{ paneId: "s1", rect: box(84, 0, 127, 20) },
		{ paneId: "s2", rect: box(84, 20, 127, 20) },
	]);
	assert.deepEqual(planPlacement(layout, ORCH, ["s1", "s2", "s3"]), {
		targetPaneId: "s3",
		direction: "down",
		bornColumn: false,
	});
});

test("planPlacement: a live id absent from the tab is ignored", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 58) },
	]);
	// "ghost" is tracked but not reported; s1 is the only real candidate.
	assert.deepEqual(planPlacement(layout, ORCH, ["ghost", "s1"]), {
		targetPaneId: "s1",
		direction: "down",
		bornColumn: false,
	});
});

test("planPlacement: an empty-panes layout gives the birth placement", () => {
	assert.deepEqual(planPlacement(tab([]), ORCH, ["s1"]), {
		targetPaneId: ORCH,
		direction: "right",
		bornColumn: true,
	});
});

test("planPlacement: garbage input never throws and yields the birth placement", () => {
	const garbage = [
		null,
		undefined,
		{},
		{ tabId: null, panes: "not-an-array" },
		{ tabId: null, panes: [{ paneId: 7, rect: box(0, 0, 1, 1) }] },
		{ tabId: null, panes: [{ paneId: "s1", rect: null }] },
	] as unknown as TabLayout[];
	for (const layout of garbage) {
		const placement = planPlacement(layout, ORCH, ["s1"]);
		assert.equal(placement.direction, "right");
		assert.equal(placement.bornColumn, true);
		assert.equal(placement.targetPaneId, ORCH);
	}
	// A garbage live list must not throw either.
	assert.equal(
		planPlacement(tab([{ paneId: ORCH, rect: box(0, 0, 84, 58) }]), ORCH, null as unknown as string[])
			.bornColumn,
		true,
	);
});

// ────────────────────────────────────────────────────────────────────────────
// planResizes — the probe's real measured rects
// ────────────────────────────────────────────────────────────────────────────

test("planResizes: birth in a 211-col root emits one 'right' op growing the orchestrator to 0.6·W", () => {
	// Probe fixture: 211-col root, orchestrator 84 wide, new pane 127 wide.
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: NEW, rect: box(84, 0, 127, 58) },
	]);
	const ops = planResizes(layout, ORCH, [NEW], NEW);
	assert.equal(ops.length, 1);
	const op = ops[0];
	assert.ok(op);
	assert.equal(op.paneId, NEW);
	assert.equal(op.direction, "right"); // 84 is too narrow: the divider moves right
	assert.ok(Math.abs(op.amount - 42.6 / 211) < 1e-9, `amount ${op.amount}`);
	// Sanity: 0.6 · 211 = 126.6, and 84 + 42.6 = 126.6.
	assert.ok(Math.abs(84 + 42.6 - 0.6 * 211) < 1e-9);
});

test("planResizes: an already-equal two-pane 29/29 column emits nothing", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 29) },
		{ paneId: NEW, rect: box(84, 29, 127, 29) },
	]);
	assert.deepEqual(planResizes(layout, ORCH, ["s1", NEW], NEW), []);
});

test("planResizes: a 29/15/14 column emits up 9.667/58 then down 4.333/38.667", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 29) },
		{ paneId: "s2", rect: box(84, 29, 127, 15) },
		{ paneId: NEW, rect: box(84, 44, 127, 14) },
	]);
	const ops = planResizes(layout, ORCH, ["s1", "s2", NEW], NEW);
	assert.equal(ops.length, 2);
	const [first, second] = ops;
	assert.ok(first && second);
	// Boundary 1: s1 (29) is 9.667 too tall; move the divider below it up.
	assert.equal(first.paneId, "s2");
	assert.equal(first.direction, "up");
	assert.ok(Math.abs(first.amount - 9.666666666666666 / 58) < 1e-9, `first ${first.amount}`);
	// Boundary 2: s2 (15) is now 4.333 too short; the node is 38.667 tall, not 58.
	assert.equal(second.paneId, NEW);
	assert.equal(second.direction, "down");
	assert.ok(Math.abs(second.amount - 4.333333333333334 / 38.666666666666664) < 1e-9, `second ${second.amount}`);
	// Pin the shrunken-node denominator explicitly, so a C-based implementation fails.
	assert.ok(Math.abs(second.amount - 4.333333333333334 / 58) > 1e-3);
});

test("planResizes: an already-equal three-pane column emits nothing", () => {
	// C = 58, t = 19.333; 20/19/19 are all within the ±1-row tolerance.
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 20) },
		{ paneId: "s2", rect: box(84, 20, 127, 19) },
		{ paneId: NEW, rect: box(84, 39, 127, 19) },
	]);
	assert.deepEqual(planResizes(layout, ORCH, ["s1", "s2", NEW], NEW), []);
});

test("planResizes: eleven panes never throws and emits at most N-1 ops", () => {
	const panes = [{ paneId: ORCH, rect: box(0, 0, 84, 110) }];
	const live: string[] = [];
	let y = 0;
	for (let i = 0; i < 11; i += 1) {
		const id = `s${i + 1}`;
		const height = i === 0 ? 100 : 1;
		panes.push({ paneId: id, rect: box(84, y, 127, height) });
		live.push(id);
		y += height;
	}
	const layout = tab(panes);
	const ops = planResizes(layout, ORCH, live, "s11");
	assert.ok(ops.length <= live.length - 1, `ops ${ops.length}`);
	assert.ok(live.length > 9);
});

test("planResizes: a new pane the tab does not report emits nothing", () => {
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 58) },
	]);
	assert.deepEqual(planResizes(layout, ORCH, ["s1"], "pane-vanished"), []);
});

test("planResizes: a single-pane column emits nothing", () => {
	// newPaneId is absent from live, so the column is just s1: N = 1, no boundaries.
	const layout = tab([
		{ paneId: ORCH, rect: box(0, 0, 84, 58) },
		{ paneId: "s1", rect: box(84, 0, 127, 58) },
		{ paneId: NEW, rect: box(84, 0, 0, 0) },
	]);
	assert.deepEqual(planResizes(layout, ORCH, ["s1"], NEW), []);
});

test("planResizes: garbage input never throws and emits nothing", () => {
	const garbage = [
		null,
		undefined,
		{},
		{ tabId: null, panes: "not-an-array" },
		{ tabId: null, panes: [{ paneId: NEW, rect: null }] },
	] as unknown as TabLayout[];
	for (const layout of garbage) {
		assert.deepEqual(planResizes(layout, ORCH, [NEW], NEW), []);
	}
	// A live list of the wrong shape must not throw either.
	assert.deepEqual(planResizes(tab([{ paneId: NEW, rect: box(0, 0, 1, 1) }]), ORCH, null as unknown as string[], NEW), []);
});

// ────────────────────────────────────────────────────────────────────────────
// LiveSubPanes — in-memory tracking, pruned against the tab
// ────────────────────────────────────────────────────────────────────────────

test("LiveSubPanes: liveIn returns tracked panes top-to-bottom regardless of insertion order", () => {
	const tracker = new LiveSubPanes();
	tracker.place("s3");
	tracker.place("s1");
	tracker.place("s2");
	const layout = tab([
		{ paneId: "s1", rect: box(84, 0, 127, 20) },
		{ paneId: "s2", rect: box(84, 20, 127, 20) },
		{ paneId: "s3", rect: box(84, 40, 127, 18) },
	]);
	assert.deepEqual(tracker.liveIn(layout), ["s1", "s2", "s3"]);
});

test("LiveSubPanes: drop removes a tracked pane", () => {
	const tracker = new LiveSubPanes();
	tracker.place("s1");
	tracker.place("s2");
	tracker.drop("s1");
	const layout = tab([
		{ paneId: "s1", rect: box(84, 0, 127, 29) },
		{ paneId: "s2", rect: box(84, 29, 127, 29) },
	]);
	assert.deepEqual(tracker.liveIn(layout), ["s2"]);
});

test("LiveSubPanes: liveIn prunes a tracked pane the tab no longer reports", () => {
	const tracker = new LiveSubPanes();
	tracker.place("s1");
	tracker.place("s2");
	const before = tab([
		{ paneId: "s1", rect: box(84, 0, 127, 29) },
		{ paneId: "s2", rect: box(84, 29, 127, 29) },
	]);
	assert.deepEqual(tracker.liveIn(before), ["s1", "s2"]);
	// The user closes s1; the next read must not return it, and the prune must
	// be lasting, so a later read without it stays clean.
	const after = tab([{ paneId: "s2", rect: box(84, 0, 127, 58) }]);
	assert.deepEqual(tracker.liveIn(after), ["s2"]);
	assert.deepEqual(tracker.liveIn(after), ["s2"]);
});

test("LiveSubPanes: dropping twice is safe", () => {
	const tracker = new LiveSubPanes();
	tracker.place("s1");
	tracker.drop("s1");
	assert.doesNotThrow(() => tracker.drop("s1"));
	assert.doesNotThrow(() => tracker.drop("never-placed"));
	assert.deepEqual(tracker.liveIn(tab([{ paneId: "s1", rect: box(0, 0, 1, 1) }])), []);
});
