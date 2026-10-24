# 01 — Print each report check to the child pane

Status: **approved**
Type: task

Implements `docs/issues/report-check-line/spec.md`.

## Change

- `src/children/report-check.ts`
  - Add `ReportCheck` (`forgotten` | `not-finished` | `{ unknown, reason }`) and
    `NOT_FINISHED`.
  - Add `inspectReport(message, route)`; `checkReport` becomes the boolean wrapper over it.
  - `createReportDecider` returns `(message) => Promise<ReportCheck>`, and answers
    `no routing transport configured` without calling the transport when neither is set.
  - Add `checkingLine(message)` and `checkLine(check)` — the two approved lines.
- `src/children/child.ts`
  - `ChildDeps.decidesReport` returns `Promise<ReportCheck>`.
  - Register an entry renderer for `tinysubagent_report_check`, dim text, one line.
  - `remindIfUnreported` appends the asking line, awaits the check (rejection →
    `unknown: the check threw`), appends the verdict line, then reminds only on
    `forgotten`.

## Acceptance

See the spec. Verify with `npm run typecheck` and `npm test`.
