# Tasks: orchestrator-first panel layout

From `tasks/plan-panel-layout.md`, spec `docs/spec-panel-layout.md`. Ordered by dependency — do
not start a task before its predecessor verifies. Checkpoint after each: `npm run typecheck` and
`npm test`.

---

- [x] **Task 1 — Scripted herdr stub**
  - Acceptance: `test/herdr.test.ts` gains `withHerdrStubScript(payloads, fn)` — one queued
    response per invocation, argv captured per invocation and returned as `string[][]`, exit
    codes settable per call. `withHerdrStub` and every existing test are untouched. A test proves
    the scripted helper itself: two calls, two distinct argv sets, two distinct payloads.
  - Verify: `npm run typecheck && npm test`
  - Files: `test/herdr.test.ts`

- [x] **Task 2 — `herdrPaneLayout` + `herdrPaneResize`**
  - Acceptance: `herdrPaneLayout(paneId): Promise<TabLayout | null>` runs
    `pane layout --pane <id>`, unwraps the envelope, and returns `null` (never throws) when the
    call fails, JSON is absent, `result.layout` is missing, or `panes` is not an array.
    `TabLayout = { tabId: string | null; panes: { paneId: string; rect: Rect }[] }`, dropping
    entries without a string `pane_id` or numeric rect. `herdrPaneResize(paneId, direction,
    amount): Promise<boolean>` runs `pane resize --direction <d> --amount <a> --pane <id>` and
    returns false instead of throwing. No call sites yet.
  - Verify: `npm run typecheck && npm test` — new tests: layout argv verbatim; envelope unwrap;
    malformed/absent layout ⇒ null; resize argv verbatim; non-zero exit ⇒ false, no throw
  - Files: `src/herdr.ts`, `test/herdr.test.ts`

- [x] **Task 3 — `planPlacement`**
  - Acceptance: pure, no I/O. `live ∩ tab.panes` empty ⇒
    `{ direction: "right", targetPaneId: orchestratorPaneId, bornColumn: true }`; non-empty ⇒
    `{ direction: "down", targetPaneId: <bottom-most live pane id by rect.y>, bornColumn: false }`.
    Tracked ids the tab does not report are ignored (not chosen as a target). An unparseable or
    empty layout falls back to the birth placement. No throw on any input.
  - Verify: `npm run typecheck && npm test` — new tests: birth; append with 1 and with 3 live
    panes (bottom-most wins, not first-in-array); a live id absent from the tab is ignored;
    garbage layout ⇒ birth placement
  - Files: `src/layout.ts`, `test/layout.test.ts`

- [x] **Task 4 — `planResizes`**
  - Acceptance: pure, no I/O. Birth: `W = orchesWidth + newWidth`,
    `delta = orchesWidth − 0.6·W`; one op `{ paneId: newPaneId, direction: delta > 0 ? "left" :
    "right", amount: |delta| / W }`, or none when `|delta| < 1`. Append: column panes ordered by
    `rect.y`, `C = Σ height`, `t = C / N`; for `k = 1..N-1` an op
    `{ paneId: pane_{k+1}, direction: height(pane_k) > t ? "up" : "down", amount:
    |height(pane_k) − t| / (C − (k−1)·t) }`, skipped when `|delta| < 1`. Already-equal panes ⇒
    `[]`. Never more than N-1 ops plus the single birth op.
  - Verify: `npm run typecheck && npm test` — new tests use the probe's real rect fixtures from
    the spec: a 211-col root at 84/127 ⇒ one op at `right`, 42.6/211, growing the orchestrator to
    126.6; a 58-row column of 2 panes at 29/29 ⇒ no ops; 3 panes at 29/15/14 ⇒ two ops — `up`
    9.67/58 (the 29 is too tall) then `down` 4.33/38.67 (the 15 is too short, and 38.67 is the
    shrunken node height, not 58); an already-equal 3-pane column ⇒ no ops
  - Files: `src/layout.ts`, `test/layout.test.ts`

- [x] **Task 5 — `LiveSubPanes`**
  - Acceptance: `place(id)`, `drop(id)`, `liveIn(tab): string[]` (tracked ∩ tab panes, top-to-
    bottom by `rect.y`). `liveIn` prunes any tracked id the tab no longer reports, so the set
    cannot grow stale across user-side closes. `drop` of an unknown id is a no-op. Ordering is by
    `rect.y`, asserted regardless of insertion order.
  - Verify: `npm run typecheck && npm test` — new tests: place/place/liveIn returns both in
    geometric order; drop removes; a tracked pane missing from the tab is dropped from the
    tracker after `liveIn` (assert via a subsequent `liveIn`); dropping twice is safe
  - Files: `src/layout.ts`, `test/layout.test.ts`

- [x] **Task 6 — `spawnOne` sequencing**
  - Acceptance: `SpawnContext` carries `columns?: LiveSubPanes`. With it: read layout → 
    `planPlacement` → open with the planned target/direction → `place(paneId)` → read layout →
    `planResizes` → apply each op. Without it: today's `direction: "right"` off
    `currentPaneId(env)`, unchanged, so `scripts/smoke.ts` and the current spawn tests keep
    passing untouched. Every layout call is best-effort: a failed read means no resize pass, a
    failed resize is ignored, and `spawnOne` still returns `{ ok: true }` with a real pane id.
  - Verify: `npm run typecheck && npm test` — new tests: with a scripted stub, the open call uses
    `--direction down` and the live pane as `--target-pane` when one is live, and `--direction
    right` + the orchestrator when none is; the resize ops issued match `planResizes`; with the
    stub exiting non-zero for every layout call the spawn is still `ok: true`; without a tracker
    the argv is byte-identical to today's
  - Files: `src/spawn.ts`, `test/spawn.test.ts`

- [x] **Task 7 — extension wiring**
  - Acceptance: one `LiveSubPanes` per `tinysubagent()` registration, passed in the `SpawnContext`
    literal (`index.ts:460`). `index.ts:403` drops the pane on the completion close. No rebalance
    and no resize is triggered by a close — the only layout calls in the codebase are the two in
    `spawnOne`.
  - Verify: `npm run typecheck && npm test` — new/updated test: the extension test's spawn path
    passes a tracker; `grep -n "herdrPaneResize\|herdrPaneLayout" src/ index.ts` shows no call
    site outside `src/spawn.ts`
  - Files: `index.ts`, `test/extension.test.ts`

- [x] **Task 8 — Layout smoke script**
  - Acceptance: `scripts/smoke-layout.ts` (plus an `npm run smoke:tool`-style `package.json`
    entry) spawns two trivial children from a real herdr session, reads `pane layout`, asserts the
    orchestrator is within ±1 col of 60% of the split rect and the two sub panes are within ±1 row
    of each other, then closes every pane it opened and exits non-zero on failure. A missing herdr
    session or an unlinked plugin skips like `scripts/smoke.ts` does, rather than failing.
  - Verify: `npm run smoke-layout` (in this repo's herdr session), then confirm no leftover panes
    via `herdr pane list`
  - Files: `scripts/smoke-layout.ts`, `package.json`

- [x] **Task 9 — Docs**
  - Acceptance: `docs/intent.md:9` states the two-column rule (orchestrator at 3/5 of its rect,
    all live subs in one right-hand column divided equally) instead of "each in a right-hand
    pane", and its "Success criteria" list gains the layout line. README: the line-4 blurb, the
    "Single or parallel" bullet, and the lifecycle list at 135-140 describe the shape and the
    three confirmed rules (no rebalance on close, later spawns join the column, a hand-dragged
    divider is never snapped back). `src/layout.ts`'s header docstring names the module's rule and
    the no-I/O constraint.
  - Verify: no `npm` command — read the three files against the spec's confirmed-intent list, and
    `grep -n "right-hand pane" docs/intent.md README.md` returns nothing stale
  - Files: `docs/intent.md`, `README.md`, `src/layout.ts`
