# Tasks: subagent result report tool

From `tasks/plan.md`. Ordered by dependency — do not start a task before its predecessor
verifies. Checkpoint after each: `npm run typecheck` and `npm test`.

---

- [x] **Task 1 — Contract constant and intent carve-out**
  - Acceptance: `REPORT_TOOL_NAME === "tinysubagent_report"` is exported from
    `src/types.ts`; `docs/intent.md:24` carries the carve-out permitting the injected
    report tool; no behavior changes and all 126 tests still pass.
  - Verify: `npm run typecheck` && `npm test` → 126/126, zero new failures.
  - Files: `src/types.ts`, `docs/intent.md`

- [x] **Task 2 — The sidecar contract (producer + consumer)**
  - Acceptance:
    - `writeResultReport("x")` writes `{"type":"done","result":"x"}` atomically and leaves
      no `.tmp` behind; returns false with no `PI_TINYSUBAGENT_REPORT` rather than throwing.
    - Existing `writeReportFile` outputs are byte-identical to today (`{"type":"done"}`,
      `{"type":"failed","reason":...}`) and its four existing test assertions are untouched.
    - `tinysubagent_report` exists, requires `result`, and calls `ctx.shutdown()` only on a
      successful write; a second call is a no-op. `tinysubagent_done` is gone.
    - A report carrying `result` classifies as `{kind:"completed", via:"report"}` and its
      text **wins over a contradicting session file**.
    - A legacy `{"type":"done"}` still classifies `via:"turn-end"` with the scraped text.
    - The malformed-report test at `test/watcher.test.ts:130` is unchanged and still passes.
    - `statusLabel` renders the reported variant.
  - Verify: `npm run typecheck` && `npm test`; new cases in `child.test.ts`,
    `watcher.test.ts`, `steer.test.ts` all fail before the change and pass after.
  - Files: `src/child.ts`, `src/watcher.ts`, `src/steer.ts`, `test/child.test.ts`,
    `test/watcher.test.ts`, `test/steer.test.ts`
  - Note: `statusLabel` must land here, not later — widening the `via` union without it
    type-checks but mislabels every reported result.

- [x] **Task 3 — Delivery wiring (allowlist + reminder)**
  - Acceptance:
    - A role whose frontmatter declares `tools` gets `tinysubagent_report` appended to its
      `--tools` list.
    - A role with **no** `tools` frontmatter still passes **no** `--tools` flag — the
      injection must not invent an allowlist that narrows the child.
    - The reminder naming `tinysubagent_report` appears in the generated task markdown.
    - `buildTaskMarkdown` output remains a single well-formed markdown document.
  - Verify: `npm run typecheck` && `npm test`; new cases in `launch.test.ts`,
    `spawn.test.ts`.
  - Files: `src/spawn.ts`, `src/launch.ts`, `test/launch.test.ts`, `test/spawn.test.ts`
  - Note: inject after the nested-delegation guard, so the guard sees exactly what the
    role declared.

- [x] **Task 4 — End-to-end verification**
  - Acceptance:
    - `npm run smoke:tool` still delivers exactly one steer message with `triggerTurn` and
      `deliverAs: "steer"`.
    - In a real herdr pane, a child can actually call `tinysubagent_report` (this is the
      only thing that proves Task 3 worked — no unit test can), its result arrives labelled
      `completed (reported)`, and the pane closes on its own.
    - A real child that never calls the tool still returns a correctly-labelled result via
      the fallback.
    - No stray panes are left open.
  - Verify: `npm run typecheck`, `npm test`, `npm run smoke:tool`, plus the manual pane run.
  - Files: none (verification only)

---

## Done when

All four tasks check green and, in a live pane, a reported result reaches the orchestrator
labelled `completed (reported)` with the pane gone.

## Not doing

A parent-side pull tool · blocking spawns · batching or ordering changes · any edit to
`deliver()` in `index.ts` · a result-size cap · retrying or validating report contents.
