# 01: an errored run holds the pane instead of reporting failure

**What to build:** a subagent whose run dies on a request/response error — provider 503, an
expired credential, a bad model, pi's retries exhausted — writes nothing and stays at its
prompt. The orchestrator is told nothing, its batch keeps waiting, and the human fixes the
provider in the pane and drives the child on to `subagent_report`, at which point the batch
finishes `completed (reported)` with the real result. Today the same error ends the batch as
`failed (error)` while the pane stays open, so the eventual report has nowhere to land.

The settle is left with exactly one branch that acts: a turn that ended cleanly without a
report gets the reminder nudge. An errored settle, an interrupted one, and an assistant-less
one all do nothing at all. The module that classified settle verdicts collapses to the single
question the child still needs: did this turn finish cleanly? Its failure vocabulary and the
abort-signal capture go with it.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] An `error` settle writes no sidecar and never shuts the child down; a unit test that
      fails on today's code proves it.
- [x] An interrupt, a tool-call Esc, and an assistant-less settle behave exactly as they do
      now: silence, pane open.
- [x] A clean turn with no report still gets the reminder, still capped.
- [x] After any silent settle a later `subagent_report` lands as reported and closes the pane.
- [x] The real-child smoke pins the new contract for the provider-outage shape: with a local
      endpoint answering 503 (both with pi's retries off and exhausted), no steer reaches the
      orchestrator while the child is held and its pane is still alive; once the endpoint is
      healthy again and the pane is driven to report, exactly one `completed (reported)` steer
      arrives carrying the child's answer.
- [x] `GLOSSARY.md`'s `Settle` entry no longer claims a settle is where an outcome is declared.
- [x] `docs/issues/child-preflight-failure/spec.md` records that its "settles `error` →
      unchanged" row is superseded here.
- [x] `npm run typecheck` and `npm test` pass; the smoke's real result is reported, not assumed.

## Answer

Implemented on `integration/silent-errors` (`0c38188`, merged `e557543`).

`src/children/settle.ts` collapsed to `finishedCleanly(messages)`; `SettleVerdict`,
`settleReason`, `failureDetail` and the abort-signal capture are gone. `agent_settled` has
one acting branch: a clean turn with no report gets the capped reminder. An `error`,
`aborted`, tool-call-Esc or assistant-less settle returns without writing or shutting down.
`scripts/smoke-provider-error.ts` now pins the hold-then-recover contract on a real child
(503 endpoint, no steer, live pane; healthy endpoint, driven report, exactly one
`completed (reported)` steer carrying the result, pane closed). `GLOSSARY.md` `Settle` and
the `child-preflight-failure` `Settles error` row are updated.

Verified: `npm run typecheck` clean; `npm test` 434/434 at the time of this ticket (420
after the ticket 03/04 test deletions); `smoke:provider-error` default, `--retries` and
`--no-auth` all PASS.
