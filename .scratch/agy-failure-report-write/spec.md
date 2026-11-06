Status: ready-for-agent

## Problem Statement

When Spawn cannot launch an `agy` child because its binary is unavailable, the user receives the existing agy-unavailable error, but the launch-preparation code has to manage the failure-report file itself. That duplicates filesystem mechanics alongside launch-file preparation and makes those mechanics harder to test independently. The task file still needs to be created, while a best-effort failure report must not replace an existing report or obscure the original launch error.

## Solution

Consolidate only the filesystem mechanics for writing the agy-unavailable failure report with the launch-path file-writing helpers. Keep the report content, the decision to treat report writing as best-effort, and the existing agy-unavailable error in the Spawn flow. Preserve normal launch behavior and pane operations.

## User Stories

1. As a user spawning an agy child when agy is unavailable, I want to receive the existing clear agy-unavailable error, so that I understand why the child did not launch.
2. As a user, I want the task file prepared before the unavailable-harness error is returned, so that the existing Spawn preparation behavior is preserved.
3. As a user, I want the failure report created when no report already exists, so that the failure remains available to the existing reporting flow.
4. As a user, I want an existing report left untouched, so that a later failed launch cannot overwrite a previously delivered result or report.
5. As a user, I want failure-report writing to remain best-effort, so that a filesystem error does not replace or prevent the existing agy-unavailable error.
6. As a user, I want task-file write failures to continue to propagate, so that a required launch-preparation failure is not silently ignored.
7. As a user launching a supported child, I want normal launch files written in the same order and manner as before, so that child startup is unaffected.
8. As a user, I want pane placement, opening, and resizing to stay in their current flow, so that this narrow filesystem change does not alter layout behavior.

## Implementation Decisions

- Move the failure-report file-writing mechanics into the existing launch-path writing module, rather than reorganizing Spawn preparation more broadly.
- The helper accepts the report path and content, creates the parent directory recursively, and writes exclusively: if the destination already exists, leave it unchanged.
- Keep report content construction and policy in the Spawn flow. It catches and ignores report-write failures, then returns the existing agy-unavailable error.
- Keep the task-file write required and preserve its existing error behavior.
- Do not change normal launch-file writing, launch ordering, report format, or pane-management operations.

## Testing Decisions

- Test observable filesystem behavior: the report's parent directory is created; a missing report is written with the supplied content; an existing report is preserved; and failure-report write errors do not change the Spawn result.
- Keep Spawn-level coverage for the externally visible agy-unavailable result and preparation behavior. Test the filesystem helper at its module boundary for the exclusive-write cases.
- Retain and run existing Spawn tests, especially coverage for launch preparation and pane operation ordering. Tests should assert outcomes and ordering that callers rely on, not internal implementation details such as a particular filesystem call sequence.
- Prior art is the existing launch-file tests exercised through Spawn and the existing Spawn behavior tests; extend those patterns rather than adding a new abstraction seam elsewhere.

## Out of Scope

- Reorganizing `spawnOne` or moving failure policy/report-content decisions out of it.
- Changing normal launch-file writes, their ordering, or the launch-path plan.
- Changing agy availability detection, the error text, or the failure-report format.
- Changing task-file failure semantics.
- Changing pane placement, opening, resizing, or layout behavior.
- General refactoring of launch preparation or other filesystem writers.

## Further Notes

The failure report is a best-effort side effect, unlike the required task-file write. Exclusive creation is important: an already-existing report must not be replaced. This spec captures the agreed narrow direction and preserves all current Spawn behavior outside that writing seam.
