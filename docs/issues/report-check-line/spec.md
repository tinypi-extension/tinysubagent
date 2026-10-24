# Spec: print the report check to the user

Status: **approved**

## Objective

Every time the child runs its report check — the classifier decision that asks "is this
final message a finished result the model forgot to hand back?" — print one line to the
user in the child's pane. Today the check is silent
(`remindIfUnreported`, `src/children/child.ts:286-320`), so the user cannot tell whether
the classifier ran, what it decided, or why nothing happened.

## Approved answers

1. **Surface:** the child pane's transcript, not a toast and not the orchestrator pane.
   The reminder itself already appears there (`child.ts:306`), so the check belongs in
   the same place.
2. **Lines:** one before the decision, one after.
   - before: `report-check: asking the classifier (<n> chars)…`
   - after, `forgotten`: `report-check: forgotten → reminding the subagent to call subagent_report`
   - after, `not-finished`: `report-check: not-finished → leaving the child alone`
   - after, no verdict: `report-check: no verdict (<reason>) → leaving the child alone`
   No confidence, no excerpt of the child's prose.
3. **Skip set:** conditions that never check print nothing — no final message, and
   `MAX_REPORT_REMINDERS` already reached (the cap is tested before the check). Interrupt
   and `no-output` settles never reach the code at all.

## Design

- **The lines are session entries, not custom messages.** They are diagnostics for the
  human: `pi.appendEntry` keeps them out of the model's context, where a
  "not-finished → leaving the child alone" line would be noise at the model's next turn.
  A `registerEntryRenderer` draws them dim, one line each.
- **The decider returns a verdict, not a boolean.** `checkReport`'s `boolean` cannot tell
  "not-finished" from "no transport configured / transport failed / unknown answer", and
  the approved lines differ. `inspectReport` returns a `ReportCheck`
  (`forgotten` | `not-finished` | `{ unknown, reason }`); `createReportDecider` returns
  that; `checkReport` stays as the boolean convenience over it.
- **No transport is a verdict, not a call.** When neither `classifierModel` nor the
  legacy `systemOne*` keys resolve, `createReportDecider` answers
  `{ verdict: "unknown", reason: "no routing transport configured" }` without calling
  anything — same behaviour as today, now with a truthful reason on screen.
- **A thrown decider is a verdict too.** The child turns a rejection into
  `{ verdict: "unknown", reason: "the check threw" }` so the failure line still prints;
  the settle is still never broken.
- The text lives in `report-check.ts` (`checkingLine`, `checkLine`), beside the criteria
  it describes; `child.ts` owns only the pi plumbing.

## Acceptance

- A reminded check appends exactly two entries, asking then `forgotten`, and still sends
  one `subagent_report` steer.
- A `not-finished` check appends asking then `not-finished`, and sends nothing.
- An `unknown` check appends asking then the reason line, and sends nothing.
- An unreported settle with no final message, or a capped child, appends nothing.
- No entry reaches the model: `appendEntry`/`registerEntryRenderer` only, never
  `sendMessage`.
