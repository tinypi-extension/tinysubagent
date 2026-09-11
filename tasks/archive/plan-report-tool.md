# Plan: subagent result report tool

Implements `docs/spec-report-tool.md`. Not started; awaiting approval.

## Objective

Make the child's result an explicit hand-back instead of an inference. The child calls
`tinysubagent_report({result})`, the payload lands atomically in the existing `.done`
sidecar, and the parent delivers that text labelled `via:"report"` — without waiting for
the turn to settle and without scraping the session.

## Decisions taken during planning

These resolve ambiguities the spec left open. Each is a choice, not a discovery.

1. **The payload writer is a second function, not a third parameter.**
   `writeReportFile(settle, detail?)` has three call sites in `src/child.ts` and is pinned by
   four assertions in `test/child.test.ts`. Rather than widen it to
   `writeReportFile(settle, detail?, result?)` — which would force
   `writeReportFile("done", undefined, text)` at the one new call site — add
   `writeResultReport(result: string): boolean` beside it. Two purposes (a signal, a
   payload), two functions, and **zero churn in existing call sites or tests**. Both share
   a private atomic writer.

2. **Atomic write is temp+rename in the target's own directory.** `renameSync` is only
   atomic within a filesystem, so the temp file is `<reportFile>.tmp`, not a tmpdir. The
   spec requires this because the sidecar grows from ~20 bytes to a full result document.

3. **The allowlist injection sits in `spawn.ts`, after the nesting guard.** `launch.ts`
   serializes whatever `tools` array it is handed and stays ignorant of the report tool.
   Ordering relative to the guard is not load-bearing (the guard matches `tinysubagent`,
   not the report name) but injecting last keeps the guard's input exactly what the role
   declared, which is easier to reason about.

4. **`via` stays a widening, not a replacement.** `"report"` is added to the union;
   `"turn-end"` and `"session-exit"` keep their meaning so existing tests and labels
   stand.

5. **Atomicity is asserted structurally, not by simulating a torn write.** A test can
   prove the target holds the full payload and that no `.tmp` is left behind. It cannot
   prove a rename was used. Stated here so nobody later mistakes the weaker test for
   proof.

## Dependency graph

```
types.ts (REPORT_TOOL_NAME) ─┬─► child.ts ──┐
                             ├─► launch.ts  │
                             └─► spawn.ts ──┤
                                            ├─► integration
watcher.ts (contract) ──► steer.ts ─────────┘

docs/intent.md — independent
```

`watcher.ts` implements the reading half of the sidecar contract and does not import
`child.ts`; the two meet at the JSON on disk. That is what lets Task 2 be built as one
slice while the files stay decoupled.

## Implementation order

Ordered by dependency. Each task is independently verifiable and touches ≤5 files.

### Task 1 — Contract constant and the intent carve-out

- `REPORT_TOOL_NAME = "tinysubagent_report"` in `src/types.ts` (dependency-free, shared by
  `child.ts` and `spawn.ts`; `spawn.ts` must not import `child.ts`, which pulls in the pi
  extension API).
- `docs/intent.md:24` — add the carve-out, since that line as written forbids the
  injection.
- **Verify:** `npm run typecheck` + `npm test` → 126/126, unchanged. This task must be a
  no-op behaviorally.

### Task 2 — The sidecar contract (the vertical slice)

Producer and consumer together, because neither is observable alone.

- `src/child.ts`
  - private `writeAtomic(file, payload)`; `writeReportFile` delegates to it.
  - `writeResultReport(result)` → `{type:"done",result}`, atomic, returns bool.
  - `tinysubagent_report` replaces `tinysubagent_done`; `{result: string}` required; writes
    then `ctx.shutdown()`; second call is a no-op; a failed write stays alive and says so.
  - Trim the module doc comment — it currently justifies "the report is deliberately
    content-free", which this change reverses.
- `src/watcher.ts`
  - `readReport` surfaces `result`.
  - `classify`: report with a non-empty `result` ⇒ `{kind:"completed", via:"report",
    summary: result}`, **before** any session read. Report without `result` ⇒ unchanged
    `via:"turn-end"` scrape. Everything else untouched, including the malformed-⇒-settled
    rule at `src/watcher.ts:90`.
  - Widen `SubagentOutcome`'s completed `via`.
- `src/steer.ts` — `statusLabel` gains `"report"` → `"completed (reported)"`. Must land in
  this task: adding the union member without it type-checks but prints the wrong label.
- Tests: `child.test.ts` (payload shape, no `.tmp` residue, no-path returns false, legacy
  signatures unchanged), `watcher.test.ts` (reported result wins over a *contradicting*
  session file; legacy `{"type":"done"}` still scrapes), `steer.test.ts` (label).
- **Verify:** `npm run typecheck` + `npm test`.

### Task 3 — Delivery wiring

- `src/spawn.ts` — inject: `if (tools !== null && !tools.includes(REPORT_TOOL_NAME))
  tools.push(REPORT_TOOL_NAME)`. The `tools !== null` guard is the load-bearing part.
- `src/launch.ts` — the reminder in `buildTaskMarkdown`, replacing the current final
  sentence.
- Tests: `launch.test.ts` (reminder present in task markdown), `spawn.test.ts` (a role
  **without** `tools` frontmatter still gets no `--tools` flag — this is the regression
  that would silently narrow every unrestricted child).
- **Verify:** `npm run typecheck` + `npm test`.

### Task 4 — End-to-end verification

- `npm run smoke:tool` — must still deliver exactly one steer message.
- A real herdr pane run if one is available, to confirm the thing the unit tests cannot:
  that the report tool is actually *callable* in a child (the whole point of Task 3) and
  that the pane closes on its own.
- **Verify:** all three commands green, and a reported result observed arriving.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The report tool is still uncallable in a real child — the injection is wrong, or pi filters extension tools differently than the docs say | Med | The docs finding is verified against `setActiveToolsByName` ("Unknown tool names are ignored", allowlist applies to extension tools). Task 4 exercises it for real; unit tests cannot prove it. |
| `ctx.shutdown()` from inside a tool `execute` misbehaves | Low | Documented as available in all contexts and a graceful *request*, so the tool result still lands. Already the exit path in the settle hook. |
| The watcher now closes the pane *before* pi finishes exiting, because the sidecar lands before `shutdown()` is called | Med | Safe by construction: the payload is on disk before `shutdown()` is invoked, so a close cannot lose work. Confirm no stray pane in Task 4. |
| Existing `writeReportFile` tests break from the atomic rewrite | Low | Signatures unchanged; separate `writeResultReport` avoids a positional-arg churn (Decision 1). |
| A crashed child leaves `<reportFile>.tmp` behind | Low | Harmless — the watcher never reads it, and it lives under the session's artifact dir. Not cleaned up; noted rather than solved. |
| Removing `tinysubagent_done` breaks a role that names it | Very low | pi ignores unknown `--tools` names; `expandToolPatterns` already warns on an unmatched literal. |

## Verification checkpoints

- **After Task 1:** 126/126, typecheck clean — proves the constant is inert.
- **After Task 2:** the contract is testable in isolation; a reported result beats a
  contradicting session file.
- **After Task 3:** the allowlist guards hold in both directions (with and without
  frontmatter `tools`).
- **After Task 4:** `npm run typecheck`, `npm test`, `npm run smoke:tool`, plus a real pane
  run.

## Parallelism

Task 1 is a hard prerequisite for 2 and 3. Tasks 2 and 3 touch disjoint files and could run
concurrently once Task 1 lands, but Task 2 is the riskier half and Task 3 is small — running
them sequentially costs little and keeps one author on the contract. Task 4 is strictly last.

## Rollback

Every change is additive to the on-disk contract: an old reader ignores `result`, and
`writeReportFile`'s two legacy shapes are preserved. Reverting means restoring
`tinysubagent_done` and dropping the injection; no migration, no sidecar cleanup, no
state to unwind. Nothing in this plan touches `deliver()` or the herdr CLI surface.

## Out of scope

As per the spec: no parent-side pull tool, no blocking spawns, no batching or ordering
change, no `deliver()` change, no result-size cap.
