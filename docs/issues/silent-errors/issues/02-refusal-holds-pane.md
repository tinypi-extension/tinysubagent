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

**Status:** ready-for-agent

- [ ] A prompt pi would refuse writes no sidecar and never shuts the child down; the mirrored
      preflight is gone, and no child-side path runs a credential check.
- [ ] The harness contract no longer asks a harness what it would refuse; both implementations
      drop it, and the type still compiles for agy's report-only shape.
- [ ] A steer typed into a live run is still not a refusal, and a refusal can no longer
      overwrite a delivered result — because nothing is written at all.
- [ ] The real-child smoke pins the refused shape: with credentials removed, no steer reaches
      the orchestrator within the hold window and the child's pane is still open; closing the
      pane by hand ends the batch `cancelled`.
- [ ] `GLOSSARY.md`'s `Refusal` entry no longer promises a report, and `Preflight` is deleted
      with the check it named.
- [ ] `AGENTS.md`'s spec-memory line for `child-preflight-failure` no longer claims a failed
      sidecar is written.
- [ ] `npm run typecheck` and `npm test` pass; the smoke's real result is reported, not assumed.
