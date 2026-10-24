# Spec: the report is the only clean ending

Status: **approved.** Supersedes the "Never" boundary of
`docs/spec-report-tool.md` ("a forgetful child must still produce a result") and amends
`docs/intent.md:45` ("Never hang forever on N/N"). Both edits are deliberate and are part
of this change, not side effects of it.

## Assumptions I'm making

1. The child is launched **interactively** (no `-p`): an idle pi stays alive at its prompt,
   so "keep the pane open" is a real state, not a hang on a dead process.
   (`src/children/launch-script.ts` agrees.)
2. The ask is **unconditional**: a `done` settle that was not preceded by
   `subagent_report` never auto-closes the pane, whether the model forgot or refused.
3. The human is the actor who resolves it, by typing into the pane or steering the child.
4. Failure and interrupt paths keep today's behaviour: a failure reports and stays alive;
   an interrupt reports nothing and stays alive.
5. The watcher needs no new state — "keep waiting" is already its default when no sidecar
   and no exit code exist. The change is entirely child-side.

→ All assumptions confirmed at approval.

## Objective

Observed failure: a subagent finished its turn, wrote a final assistant message, and never
called `subagent_report`. The settle hook then stamped `{"type":"done"}`, shut the child's
pi down, and the pane closed. The orchestrator either received a scraped result it could
not use or nothing at all, and the pane it is told to inspect is already gone. The work is
unrecoverable because the only copy of the child's context died with the pane.

**Fix:** an unreported turn end is not an ending. The child writes nothing and does not
shut down; it sits at its prompt. The orchestrator keeps waiting, and the human can read
the pane, steer it, and ask for the report. The pane then closes the way it always should
have — when `subagent_report` is actually called.

**User:** the human orchestrating, and the model orchestrator driving tinysubagent.

## The rule change

Child-side, `agent_settled`, `settle === "done"` branch (`src/children/child.ts`):

| | today | this change |
|---|---|---|
| sidecar | `writeReportFile("done")` | **nothing written** |
| pane | `ctx.shutdown()` → pane closes | **stays open at the prompt** |
| watcher | classifies `via:"turn-end"`, scrapes session | keeps polling the same pane |

Nothing else moves. A report is still the only path that closes the pane automatically.

### What still ends a wait (all unchanged)

| Signal | Outcome |
|---|---|
| `subagent_report({result})` | `completed / via:"report"`, pane closed |
| pi exits 0 (user quits the child) | `completed / via:"session-exit"` |
| pi exits non-zero | `failed / reason:"exit"` |
| `failed` settle | `failed / reason`, pane left open |
| pane closed by hand | `cancelled` |

The new terminal set is therefore: *reported*, *exited*, *failed*, *closed*. A finished
turn is not in it.

## Consequence: the batch can now wait indefinitely

This is the point of the change and it is also its cost. `docs/intent.md:45` promises
"never hang forever on N/N"; the honest replacement is: **the batch waits until every
child has reported, exited, failed, or had its pane closed.** A child that ends a turn
without reporting holds the batch until a human acts on its pane.

The escape hatches are all one keystroke: say "call `subagent_report`" in the pane, or
`/quit` it (exit 0 → `completed`), or close the pane (`cancelled`).

`docs/intent.md:45` gets an explicit carve-out for the unreported case rather than being
quietly contradicted.

## Consequences to fix in the same change

- **The fallback promise is now false** and must be removed from both places it is made:
  - the tool result for a failed `writeResultReport` — "finish your turn normally and the
    caller will read your final message instead" is no longer true; the model must retry;
  - the task-markdown output contract — "if the report does not arrive, the caller reads it
    instead" is no longer true; a skipped report leaves the pane open and the batch waiting.
- **Tests that encode the old contract are inverted, not deleted**: the "redirected child
  reports on its next settle" and "a settle whose report write fails still closes the pane"
  cases describe behaviour this spec removes, and are replaced by their new expectations.
- **Real-child smokes** (`smoke.ts`, `smoke:tool`) currently lean on the settle fallback for
  their child to finish. They must either drive a child that calls the tool (the default
  task already instructs it) or close the pane themselves on the success and failure paths,
  exactly as `smoke-layout.ts` already does.

## Files

| File | Change |
|---|---|
| `src/children/child.ts` | `done` branch of `agent_settled` writes nothing and does not shutdown; rewrite the module doc ("the settle fallback") and the tool's failed-write message |
| `src/children/task-markdown.ts` | output contract states the pane stays open until the tool is called |
| `docs/intent.md` | line 45 carve-out; the interrupt paragraph keeps its silence rule |
| `docs/spec-report-tool.md` | status line points here; `Never` boundary and the classification row for `done` without `result` corrected |
| `test/children/child.test.ts` | inverted expectations above |
| `test/children/watcher.test.ts` | only if a case asserts the settle path produces a terminal outcome from a `{"type":"done"}` written by the child — the watcher's own handling of that payload is unchanged and stays tested |

`src/children/watcher.ts`, `src/present/steer.ts` and `src/pi/watch-batch.ts` are **not**
changed: the watcher already treats "no sidecar, no exit code, pane alive" as "keep
waiting", and `via:"turn-end"` is still reachable through a manual quit-then-settle.

## Boundaries

- **Always:** run `npm run typecheck` and `npm test` before calling this done; keep the
  sidecar contract byte-compatible (no new keys); state the new wait semantics in the docs
  that promised the old ones.
- **Ask first:** anything that delivers a message to the orchestrator while the batch is
  still waiting (see Open questions 1); a config/env switch to restore auto-close (2);
  changing failure or interrupt behaviour (it should not change).
- **Never:** leave the old promise in a doc comment or a test comment; make the settle path
  close a pane again; weaken an existing test instead of rewriting its expectation.

## Success criteria

1. A `done` settle with no report writes no sidecar and never calls `shutdown()` — proven by
   a unit test that fails on today's code.
2. After such a settle, a later `subagent_report` still lands `via:"report"` and closes the
   pane — the child is recoverable, not wedged.
3. A `done` settle whose sidecar path is unwritable is indistinguishable from the normal
   case: nothing written, pane open, no throw.
4. No doc, comment, or tool message still claims the caller falls back to the session
   scrape when the child forgets to report.
5. `npm run typecheck` and `npm test` pass; `npm run smoke:tool` delivers exactly one steer
   message, labelled `completed (reported)`.

## Resolved decisions (at approval)

1. **The orchestrator gets no notice while the batch is held.** A child that ends a turn
   without reporting is resolved by a human at the pane, and the orchestrator hears nothing
   until that happens. A steer notice (option b) is a possible follow-up, not part of this
   change.
2. **No config flag restores auto-close.** CI and the real-child smokes are callers to fix:
   their tasks must instruct the child to call `subagent_report`.
3. **A settle with no assistant message stays silent too.** `settleReason` returns
   `failed` / `no-output` there; the settle treats it like the unreported `done` — nothing
   written, no shutdown, watcher keeps waiting. Only an `error` stop reason still reports
   `failed` (with the pane left open).
