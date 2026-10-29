# Spec: an error is not an ending either

Status: **needs-triage** — every decision below was resolved in session with the user and
is recorded under "Resolved decisions". No plan or todo file accompanies this spec; the
repo's `plan.md`/`todo.md` conventions are deprecated.

Supersedes the `failed`-settle row of `docs/issues/report-required/spec.md` ("What still
ends a wait") and acceptance criteria 3 and 5 of
`docs/issues/child-preflight-failure/spec.md`. The sidecar *contract* is not changed: the
schema and the reader stay exactly as they are.

## Assumptions I'm making

1. The child is launched **interactively**, so an errored pi is alive at its prompt — the
   same assumption `report-required` makes for an unreported turn end.
2. pi retries transient request errors itself, so a settle carrying an `error` stop reason
   is after retries are exhausted (or was never retryable: auth, bad model, malformed
   request). Either way the human is the only one who can resolve it.
3. **The request is pi-only.** agy gets no extension (`supportsExtension: false`) and its
   `readRefusal` always returns `null`; its wrapper's `failed`/`no-output` write fires after
   agy has exited, when there is no pane left to hold. agy behaviour is untouched.

→ Confirmed at approval.

## Objective

Observed failure: a subagent's run hits a request/response error — a 503, a rate limit pi
gives up on, a credential that expired, a model that is not there. The settle hook stamps
`{"type":"failed",…}`, the orchestrator's batch **ends** with `failed (error)` and the
orchestrator moves on. Meanwhile the human fixes the provider in the child's pane — which
is still open, precisely so it can be fixed — and the child finishes and calls
`subagent_report`. Nothing delivers it: the batch that was waiting is gone. The work is
recoverable in the pane and unrecoverable in the orchestrator, which is the worst of both.

**Fix:** a run that errored, and a run pi will not start, are *not endings*. The child
writes nothing, stays at its prompt, and the wait continues until the human has resolved
it and the child reports. This is the rule `report-required` already applies to an
unreported `done`; this spec removes the last two exceptions to it.

**User:** the human orchestrating, and the model orchestrator driving tinysubagent.

## The rule change

### Settle (`agent_settled`, `src/children/child.ts`)

| settle verdict | today | this change |
|---|---|---|
| `done` | nothing written; nudge via `REPORT_REMINDER` | unchanged |
| `interrupted` (abort, or a tool-call Esc seen as `error`) | nothing written | unchanged |
| no assistant message at all (`no-output`) | nothing written | unchanged (already silent) |
| **`error` stop reason (503, auth, bad model, tool error)** | `{"type":"failed","reason":"error"}`, pane open, batch ends | **nothing written**, pane open, batch keeps waiting |

### Refusal (`input` hook)

| situation | today | this change |
|---|---|---|
| **pi refuses the prompt** — `No API key found for <provider>`, no model selected | `{"type":"failed","reason":"error","message":…}` naming the provider and `/login` | **nothing written**; the child's own pane already carries pi's message |
| a steer typed into a live run | nothing written | unchanged |
| a refusal after a delivered result | nothing written (result wins) | unchanged |

The mirrored preflight exists for exactly one purpose: to *write* that sidecar, because pi
fires no extension event for a `prompt()` that throws. With the write gone, **the whole
subsystem has no caller** and is deleted rather than left as a check nobody reads: the
`input` hook, `src/children/preflight.ts`, and `ChildHarness.readRefusal` (whose only
implementations are pi's preflight and agy's `null`).

The consequence, stated plainly: **a batch whose provider is misconfigured now tells the
orchestrator nothing at all.** It waits, exactly as it waits for an unreported turn end.
The ack is the only clue, and the human finds the pane the same way they find any held
child.

### What still ends a wait (all unchanged)

| Signal | Outcome |
|---|---|
| `subagent_report({result})` — the human resolved the error, the child reported | `completed / via:"report"`, pane closed |
| pi exits 0 (human `/quit`s a held child) | `completed / via:"session-exit"` |
| pi exits non-zero | `failed / reason:"exit"` |
| pane closed by hand | `cancelled` |
| pre-spawn spawn failure (herdr, cwd, profile) | the tool call itself returns the error; no child, no sidecar |

The terminal set stays *reported*, *exited*, *failed-as-a-process-fact*, *closed*. No
child-written payload is in it any more: after this change the child writes **only**
success, and `failed` names what a *process* did, never what a *turn* did.

## Consequence: dead code, deleted rather than kept

The failure vocabulary loses every writer:

| Symbol | Fate |
|---|---|
| `writeReportFile` and `ChildSettle` (`src/children/report.ts`) | deleted — its `done` arm already became a no-op in `report-required`, its `failed` arm is this change |
| `errorText`, `preflightFailure`, `preflightRefusal` (`src/children/preflight.ts`) | deleted with the module |
| `ChildHarness.readRefusal` (`harness/types.ts`, `harness/pi.ts`, `harness/agy.ts`) | deleted from the contract |
| `failureDetail`, `SettleVerdict`, `ChildSettle` (`settle.ts`) | deleted |
| settle's `runSignal` capture (`agent_end`) | deleted — it existed to tell an interrupt from an error, and both are silent now |
| `agent_end` capture of `lastMessages` | **kept** — `agent_settled` carries no messages |

`settle.ts` collapses to the one question the child still needs answered: *did this turn
end with an assistant message that finished cleanly?* — because that is the only case that
earns a nudge. A non-finished settle does nothing at all.

**The reader is untouched.** `src/children/watcher.ts` keeps parsing
`{"type":"failed",reason[,message]}` and keeps its tests: the sidecar contract is frozen,
a sidecar written by an earlier build still classifies correctly, and the malformed-input
rules must not drift.

## Consequences to fix in the same change

- **`scripts/smoke-provider-error.ts` inverts.** Today it asserts `failed (error)` plus the
  `503` text / `no API key` reason reaching the orchestrator. It becomes the proof that a
  real child is *held, not reported*: a local 503 endpoint, no steer arrives within a
  window, the child's pane is still alive, then the pane is driven to `subagent_report`
  and the batch completes `completed (reported)`. `--no-auth` and `--retries` stay as the
  two shapes of the same claim.
- **Tests that encode the old contract are inverted, not deleted**, except where the code
  they pin is deleted outright (the refusal tests and `writeReportFile`'s sidecar-shape
  tests have no subject left):
  - `test/children/child.test.ts` — "an errored turn is a failure", "a turn with no
    assistant message at all counts as failed", "a real error is still reported as a
    failure", "the refusal message names the provider and the fix", the refusal suite
    (~10 cases), and the `writeReportFile` shape cases.
  - `test/children/harness-pi.test.ts` — the `readRefusal` assertion.
  - `test/children/watcher.test.ts` — unchanged; its `message`-carrying failure cases keep
    pinning the reader.
- **The docs that promise failure reporting** must stop promising it:
  - `GLOSSARY.md` — `Settle` ("the only moment an outcome may be declared" is now false),
    `Refusal` ("must still be reported as failed" is now false), and `Preflight` (deleted
    with the module; there was never a pre-pane check).
  - `docs/issues/child-preflight-failure/spec.md` — status becomes *partially superseded*
    with a pointer here.
  - `AGENTS.md` spec-memory index — the `child-preflight-failure` line no longer claims the
    failed sidecar is written.

## Files

| File | Change |
|---|---|
| `src/children/child.ts` | `agent_settled` writes nothing but the `done` nudge; delete the `input` hook and its imports; drop the `runSignal` capture; rewrite the module doc |
| `src/children/settle.ts` | collapse to the "finished cleanly" predicate; delete `failureDetail`/`SettleVerdict` |
| `src/children/report.ts` | delete `writeReportFile`/`ChildSettle`; keep `writeAtomic`/`writeResultReport`; keep the frozen contract in the module doc |
| `src/children/preflight.ts` | delete the file |
| `src/children/harness/{types,pi,agy}.ts` | drop `readRefusal` from the contract and its two implementations |
| `test/children/child.test.ts` | inverted expectations listed above |
| `test/children/harness-pi.test.ts` | drop the `readRefusal` case |
| `scripts/smoke-provider-error.ts` | inverted to pin the hold, then the recovered report |
| `GLOSSARY.md`, `AGENTS.md`, `docs/issues/child-preflight-failure/spec.md` | the promise edits above |

`src/children/watcher.ts`, `src/present/steer.ts`, `src/pi/watch-batch.ts`,
`src/children/launch-script.ts` and `src/children/task-markdown.ts` are **not** changed: the
watcher already treats "no sidecar, no exit code, pane alive" as "keep waiting".

## Boundaries

- **Always:** run `npm run typecheck` and `npm test`; keep the sidecar *reader* and its
  contract byte-compatible; run `npm run smoke:provider-error` in both modes and report the
  real result; state the new wait semantics wherever the old ones were promised.
- **Ask first:** anything that delivers a message to the orchestrator while a batch is
  still waiting (including "child X errored"); a config or env switch that restores
  failure reporting; a timeout or watchdog that gives up on a held child.
- **Never:** write a `failed` sidecar from the child again; weaken a test instead of
  inverting or deleting it with its subject; leave a doc, comment or tool message claiming
  the orchestrator is told about an error.
- **Out of scope:** reclassifying exit 0 with no report (a human `/quit`ing a held child
  still ends the batch `completed / session-exit`); agy behaviour; interrupt behaviour.

## Success criteria

1. An `error` settle writes no sidecar and never calls `shutdown()` — proven by a unit test
   that fails on today's code.
2. A prompt pi would refuse writes no sidecar and never calls `shutdown()`; the mirrored
   preflight no longer exists to run.
3. After either, a later `subagent_report` still lands `via:"report"` and closes the pane —
   the child is recoverable, not wedged.
4. No `failed` sidecar is writable by any child-side path; the reader still classifies a
   `failed` payload, with and without `message`, exactly as before.
5. No doc, comment, or tool message claims the orchestrator learns about a child's error.
6. `npm run typecheck` and `npm test` pass; `npm run smoke:provider-error` (default,
   `--retries`, `--no-auth`) shows no steer while held and one `completed (reported)` steer
   after the pane is driven to report.

## Resolved decisions (at approval)

1. **Every failure settle goes silent**, not only request/response-shaped ones: telling a
   transient error from a permanent one inside the child means pattern-matching pi's error
   prose, and the pane is the resolution path in all of them.
2. **The in-pane refusal goes silent too**, even though it means a misconfigured provider
   batch now waits with no signal at all. Reporting `failed` there is what makes the later
   report undeliverable — the same bug, in the case most likely to end in a good retry.
3. **The child's `failed` writer is deleted**, and with it the preflight subsystem that
   existed only to feed it. A dead writer "proving" a contract nothing honours is the kind
   of stale promise `report-required` was written to remove.
4. **The reader and the sidecar contract are untouched**, including `message`.
5. **No steer notice while a batch is held**, consistent with the decision already made for
   unreported turn ends.
6. **No reminder in the pane on an error settle.** The error is the last thing on screen; a
   synthetic steer would overwrite the message the human needs to read.
7. **`smoke-provider-error` is inverted, not deleted.** It is the only test that proves a
   real held child is recoverable.
8. **The glossary gains no new vocabulary.** `Unreported turn end` already covers this ("a
   settle with no report… not an ending"); only the entries that promise reporting change.
9. **No ADR.** This reverses a spec, and the reversal is recorded here with its reasons.
10. **Exit 0 without a report stays `completed / session-exit`.** Whatever a human types
    before `/quit`ing a held child is still the result; the pane and the human are both
    gone by the time this is classified.
