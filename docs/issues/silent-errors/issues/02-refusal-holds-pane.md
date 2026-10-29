# 02: a run pi refuses to start holds the pane instead of reporting failure

**What to build:** a subagent spawned with no usable credentials — pi prints
`No API key found for <provider>.` and refuses the prompt — writes nothing and sits at its
prompt. The human runs `/login <provider>` (or fixes whatever else pi refuses), drives the
child on, and the report lands. The orchestrator is never told the child could not start.

The child's mirrored preflight exists for one purpose only: writing that `failed` sidecar,
because pi fires no extension event for a `prompt()` that throws. With the write gone the
whole check has no reader, so it goes: the `input` hook, the preflight module, and the
harness member that fed it (pi's check and agy's always-null stub). What remains is the
honest consequence — a batch whose provider is misconfigured waits silently, exactly like a
batch holding an unreported turn end.

**Blocked by:** 01 — this ticket's smoke work edits the same real-child smoke script that 01
rewrites. The behaviour itself does not depend on 01.

**Status:** resolved

- [x] A prompt pi would refuse writes no sidecar and never shuts the child down; the mirrored
      preflight is gone, and no child-side path runs a credential check.
- [x] The harness contract no longer asks a harness what it would refuse; both implementations
      drop it, and the type still compiles for agy's report-only shape.
- [x] A steer typed into a live run is still not a refusal, and a refusal can no longer
      overwrite a delivered result — because nothing is written at all.
- [x] The real-child smoke pins the refused shape: with credentials removed, no steer reaches
      the orchestrator within the hold window and the child's pane is still open; closing the
      pane by hand ends the batch `cancelled`.
- [x] `GLOSSARY.md`'s `Refusal` entry no longer promises a report, and `Preflight` is deleted
      with the check it named.
- [x] `AGENTS.md`'s spec-memory line for `child-preflight-failure` no longer claims a failed
      sidecar is written.
- [x] `npm run typecheck` and `npm test` pass; the smoke's real result is reported, not assumed.

## Answer

Implemented on `integration/silent-errors` (`7756c9b`, merged `6c72b3c`).

A refused prompt now writes nothing and never shuts the child down: `src/children/preflight.ts`
is deleted, the `input` hook is removed from `child.ts`, `readRefusal` is dropped from
`harness/{types,pi,agy}.ts`, and `contract.ts` no longer references the deleted module.
`test/children/child.test.ts` lost the whole refusal suite and its preflight-only stub
plumbing. `smoke:provider-error --no-auth` now holds for 15 s with zero steers, confirms pi's
refusal on the pane, then closes the pane and gets exactly one `cancelled`. `GLOSSARY.md`
(`Refusal`, `Preflight` deleted) and the `AGENTS.md` index line are updated.

Verified: `npm run typecheck` clean; `npm test` 426/426 at the time of this ticket; all
three smoke modes PASS.
