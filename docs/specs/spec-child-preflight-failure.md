# Spec: a run pi refuses to start is still reported

Status: implemented. Extends `docs/intent.md` (failure reporting) and the
failure half of `docs/spec-report-tool.md`; it contradicts neither.

## Assumptions I'm making

1. **Esc stays silent.** The interrupt rule is not touched: a child the user stopped is
   alive at its prompt and reports nothing. Nothing here reopens that.
2. **"Reported" means the existing path** — one `{"type":"failed",...}` sidecar, one steer
   message for the batch, pane left open. No new files, no new watcher terminal state, no
   new herdr call.
3. **The child does not shut down when it reports this failure.** The pane is where the
   user runs `/login`; closing it would take away the only place the error is actionable.
   This matches how every other failure is already left on screen.
4. **The child repeats pi's preflight rather than waiting for pi's throw**, because no
   extension event fires for a `prompt()` that throws. Verified against pi 0.85.1
   (`core/agent-session.js`, `prompt()`): the `input` hook is emitted *inside* that call,
   immediately before the model/auth validation, and pi awaits it — so it is the only
   place a child can see the refusal coming.
5. **`message` is additive on the failure sidecar.** An old reader ignores the field and
   still works; a new reader falls back to the session as before when it is absent.

→ Correct these now or I proceed with them.

## Objective

Keep the promise the interrupt rule makes: *silence means the child is alive and the user
is still steering it.* Silence must not also mean "the child could not start and nobody
will ever be told", because the orchestrator cannot see the pane and waits forever.

## Scope check

One capability. No capability map.

## The gap

| How the child ends | Before | Intended |
|---|---|---|
| Settles `done` | `{"type":"done"}` | unchanged |
| Settles `error` (503, bad model, tool failure) | `{"type":"failed","reason":"error"}`, reason scraped from the session | unchanged |
| Esc / abort | nothing — the wait continues on the live pane | unchanged |
| **pi refuses the prompt** (no model selected, no usable credentials for the provider) | **nothing** — no run, so no `agent_end`, so no `agent_settled` | `{"type":"failed","reason":"error","message":...}` |

The last row is a real hang, reproduced end to end: a child spawned with an
unauthenticated provider prints `No API key found for oc-openai.` in its pane, writes no
sidecar, and the orchestrator's batch waits on it indefinitely (`scripts/smoke-provider-error.ts
--no-auth`, which failed on a 90s watchdog before this change and passes in ~1s after it).

## The data contract

One sidecar, extended additively. `<sessionFile>.done`:

```jsonc
{"type":"done","result":"<the child's result text>"}                 // explicit hand-back
{"type":"done"}                                                      // settled, no payload
{"type":"failed","reason":"error"|"aborted"|"exit"|"no-output"}       // settle hook
{"type":"failed","reason":"error","message":"<why it could not start>"} // preflight refusal
```

`message` is optional and only ever written on a failure. It exists because a refusal
leaves **no turn behind**, so there is no session text for the parent to scrape; without it
the orchestrator would receive a bare `failed (error)` and have to go read the pane.

The parent's failure summary is therefore `report message ?: last assistant text ?: session
failure note`. The message leads because it is written **for the run that is ending now**,
while `readFinalMessage` scans the whole session for the last assistant text it can find —
which, after an interrupt, is a turn from *before* the refusal. Preferring the scrape there
would hand the orchestrator the interrupted turn's words as the error and hide the reason
the batch actually stopped. A message is never written for a run that produced a turn, so
the two only ever disagree in that case.

### Classification (extends the table in `docs/spec-report-tool.md`)

| Report | Outcome | `summary` |
|---|---|---|
| `failed`, reason ≠ `aborted`, with `message` | `{kind:"failed", reason}` | `message` ?: session text ?: failure note |
| `failed`, reason ≠ `aborted`, no `message` | `{kind:"failed", reason}` | session text ?: failure note (unchanged) |

### Keeping the mirror honest

The child's copy of the preflight is deliberately **weaker** than pi's, so it cannot fail a
child pi would have run:

1. `hasConfiguredAuth(model)` — pi's own cheap first step; a credential already known is
   enough, and nothing is resolved (or refreshed) for it.
2. `getProviderAuthStatus(provider).configured` — the registry's local view, which also
   counts a stored credential the availability snapshot has not caught up with. pi's check
   sees that credential too, so the child must not go further and try to *use* it.
3. `getProviderAuth(provider)` — pi's fallback, and the only step that can refresh an OAuth
   token or touch the network. `undefined` means pi refuses.

A step that throws is reported as `could not resolve credentials for "<provider>" — <cause>`
rather than guessed at as "no API key": the lookup failing is a fact, which is more than the
child knows about pi's verdict.

## Acceptance criteria

1. **Esc is still silent.** No sidecar, no steer, pane open, wait continues — *until pi
   refuses that child's next run*, which is a failure and is reported (see #6).
   Pinned by `npm run smoke:interrupt`, `test/children/child.test.ts` (three interrupt cases).
2. **In-run failures still reach the orchestrator with their reason.** Pinned by
   `test/children/child.test.ts`, `test/children/watcher.test.ts`, and `npm run smoke:provider-error`
   (503, with and without pi's retries).
3. **A refusal is reported, not waited on.** An idle child whose provider has no usable
   credentials writes `{"type":"failed","reason":"error","message":...}` on the prompt,
   and the orchestrator's steer shows `failed (error)` with `**Error:**` naming the
   provider and the `/login` command. Pinned by `test/children/child.test.ts` and
   `npm run smoke:provider-error -- --no-auth`.
4. **No false failure for a child that can run.** A configured child, and a child whose
   credentials only resolve through the provider lookup, write nothing on input.
5. **No false failure mid-run.** Input typed while a run is live is a steer, not a
   refusal: nothing is written, because the run reports for itself at settle.
6. **A refusal cannot overwrite a delivered result**, and an interrupt followed by an
   unstartable redirect is reported (the interrupt rule must not hide a real failure),
   with the refusal message as the summary rather than the interrupted turn's text.
7. **The child's preflight never fails a child pi would have run**: a credential known to
   the registry, whether from the snapshot, the environment, or storage, ends the check
   before anything is resolved.

## Boundaries (out of scope)

- **No timeout or watchdog.** A child that is alive at its prompt and never prompted again
  still holds its batch open, exactly as `docs/intent.md` decides. Latency is not failure.
- **No new failure vocabulary.** The reason stays `error`; the explanation rides in
  `message`.
- **No retry, no re-auth, no pane management.** The child reports; the human fixes.
- **Not covered: the compaction lock.** `prompt()` throws that one *before* the `input`
  event is emitted (`agent-session.js` — the compaction guard sits above `emitInput`), so a
  child cannot see it from this hook at all; it would need a different hook or an upstream
  reorder. Interactive mode queues the text in that state instead of calling `prompt()`, so
  a pane does not reach it today either.
