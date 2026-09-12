# Todo: the report is the only clean ending

Implements `docs/spec-report-required.md` per `tasks/plan.md`. Baseline at `f5f24a5`:
typecheck clean, `npm test` → 246 pass / 0 fail.

- [x] **R1 — child settle silence.** `agent_settled`: `done` returns with no write and no
  shutdown (`_ctx`); after the interrupt guard, `failureDetail === "no-output"` also
  returns; only an `error` stop reason reaches `writeReportFile("failed", …)`. Module doc
  rewritten (no "two paths"/"settle fallback"/"never hang" claims — the new rule is stated);
  failed-write tool message now says retry, pane stays open, caller keeps waiting (`/could
  not/i` kept for the test regex).
  - Files: `src/children/child.ts`
- [x] **R2 — caller-facing text.** `task-markdown.ts`: fallback sentence replaced with
  "ending your turn without the call sends nothing; the pane stays open and the caller
  keeps waiting"; module doc updated. `spawn.ts`: nested-delegation rationale reworded —
  a grandchild's result lands in the subagent's session and nothing carries it up; no more
  "pane closes when its turn settles" claim.
  - Files: `src/children/task-markdown.ts`, `src/children/spawn.ts`
- [x] **R3 — docs.** `docs/intent.md`: the "never hang forever on N/N" promise amended to
  the new wait semantics with a pointer to the spec; the silence paragraph covers
  unreported finishes. `docs/spec-report-tool.md`: status points at
  `spec-report-required.md`; the `done`-without-result row marked legacy; the amended
  "Never" boundary annotated. `README.md`: nested bullet reworded; Lifecycle 4 states the
  pane closes only on report/quit/close and that an unreported turn end holds the batch.
  - Files: `docs/intent.md`, `docs/spec-report-tool.md`, `README.md`
- [x] **R4 — smokes + tests.** `scripts/smoke.ts` tasks instruct `subagent_report` with the
  expected result instead of "do not use any tools". `test/children/child.test.ts`:
  "redirected child reports on next settle" inverted → no sidecar, 0 shutdowns; "settle
  whose report write fails still closes the pane" replaced by "a done settle writes
  nothing and keeps the pane open"; added "no assistant message is silence too"; kept
  unchanged: real-error failure, settle-after-report, failed report write (/could not/i),
  report.ts units, preflight/input tests.
  - Files: `scripts/smoke.ts`, `test/children/child.test.ts`
- [x] **R5 — checkpoint + archive + commit.** `npm run typecheck` clean; `npm test` →
  **247 pass / 0 fail** (246 + 1 net new). Real-child smokes not runnable here. Code-layout
  plan/todo archived as `tasks/archive/{plan,todo}-code-layout.md`.
  - Files: `tasks/plan.md`, `tasks/todo.md`, `tasks/archive/*`
