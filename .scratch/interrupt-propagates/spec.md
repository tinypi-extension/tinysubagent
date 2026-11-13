# Interrupt propagates to the children

Status: resolved

## Problem Statement

An operator interrupts the orchestrator's turn — Esc — and the blocking call returns, but nothing inside the batch stops. Every child keeps running its turn in its pane, burning model calls against work the operator has just abandoned. The call's rows claim `cancelled (pane closed without reporting)`, which is the opposite of the truth: not one pane was closed, and the children were never cancelled in any sense. To actually stop the work the operator has to visit each sub pane and press Esc there too, once per child, in a hurry and in the wrong pane order.

The old consequence — "interrupting the orchestrator's turn ends the wait as `cancelled` and never closes a child's pane" (ADR 0001) — described a call that gave up waiting silently. In practice the operator pressing Esc means *stop this*, not *stop watching this*, and the batch is exactly the thing they want stopped.

## Solution

One Esc in the orchestrator's pane interrupts every live sub pane this registration holds: each child's current turn is stopped by relaying an Esc into its pane, so it comes to rest at its own prompt. Nothing is closed — no child is cancelled, and every pane stays visible and usable, so the operator can read what each child had reached and redirect it by hand.

The call still returns immediately, and each child is reported with its own ending: **interrupted**, not cancelled. An Esc that lands mid-spawn stops the rest of that batch from being started at all: a turn being interrupted should not launch new work.

Interrupt is relayed, never escalated. A second Esc, an Esc against a child that had already stopped, or an Esc whose pane has vanished changes nothing and closes nothing.

## User Stories

1. As an orchestrator operator, I want one Esc in the orchestrator's pane to interrupt every live child of this registration, so that abandoning a batch actually stops the work instead of only stopping my view of it.
2. As an orchestrator operator, I want the interrupt to reach children of earlier calls that are still live, so that a single Esc covers everything this session started, not just the batch in flight.
3. As an orchestrator operator, I want a child that is already at its prompt to be interrupted harmlessly, so that the batch-wide Esc needs no per-child bookkeeping about who is mid-turn.
4. As an orchestrator operator, I want no pane to be closed by an interrupt, so that every child's pane is still there to read and redirect afterwards.
5. As an orchestrator operator, I want the call to return as soon as the interrupt is relayed, so that Esc gives me my turn back immediately rather than after a confirmation round-trip.
6. As an orchestrator operator, I want an Esc that lands mid-spawn to stop the remaining spawns, so that a batch being abandoned does not open fresh panes.
7. As an orchestrator operator, I want a second Esc to do nothing, so that interrupting is idempotent and never escalates into killing panes by accident.
8. As an orchestrator operator, I want an interrupt that cannot be delivered — a pane already gone, a herdr error — to pass silently, so that a vanished pane does not turn into a fake failure in the result.
9. As an orchestrator operator, I want the abort to propagate whatever caused it, so that a session shutdown and an Esc have the same effect on the children.
10. As an orchestrator, I want an interrupted child reported as interrupted rather than cancelled, so that I can tell "the operator stopped this" from "the pane disappeared".
11. As an orchestrator, I want interrupted children to carry no summary, so that half-written assistant text is never mistaken for a report.
12. As an orchestrator, I want an interrupted batch to be a readable result rather than an error, so that my next turn can plan around the abandonment instead of treating it as a tool defect.
13. As an orchestrator, I want the interrupted result to say the batch was interrupted and the panes were left open, so that I know why no reports came back and where the work stands.
14. As an orchestrator, I want Labels released exactly as they are today, so that a Label whose child was interrupted can be reused without waiting for a pane to close.
15. As an orchestrator, I want a child whose wait settles for other reasons — a report, an exit, a vanished pane — to be reported exactly as it is today, so that interrupt propagation changes nothing about normal outcomes.
16. As an orchestrator, I want the `cancelled` ending to keep meaning only "the pane vanished", so that the two endings never blur into each other again.
17. As a maintainer, I want the direction recorded in a new ADR that ADR 0001 points at, so that the reversal of that consequence is explainable rather than looking like drift.
18. As a maintainer, I want the glossary to carry the muted interrupt and the new ending, so that future work does not reintroduce "cancel" as a synonym for "interrupt".
19. As a maintainer, I want the relayed-Esc fan-out proven against a real herdr, so that the feature's only risky boundary — typing into another pane — is not taken on faith.
20. As a maintainer, I want the fan-out proven at the tool call's own seam, so that the test asserts the commands herdr received rather than a mock's memory of a decision.
21. As a maintainer, I want the TUI to render an interrupted child distinctly from a cancelled one, so that the operator reading the transcript sees which ending happened.

## Implementation Decisions

- **The fan-out lives in its own module**, beside the other child concerns: one function that takes pane identifiers and relays an Esc into each through the pane CLI. It is fire-and-forget — it never awaits a pane's answer, never throws, and never reports a failure upward.
- **The batch watcher is the trigger.** Its abort forwarding — today the code that aborts each child's controller so the call can return — becomes: relay the Escs to the live sub panes, then end every wait. The watcher already owns the abort path, so no new abort plumbing is introduced anywhere else.
- **What gets interrupted is this registration's live sub panes**, not the current batch and not the tab. Live sub panes are already tracked for placement; that set is the scope, so a child of an earlier call that never reported is covered, while another orchestrator's panes are not.
- **Mid-turn is not detected.** The signals that would tell a child's turn state appear only at settle, so the interrupt is deliberately blunt and batch-wide. This is a stated property of the feature, not a gap to close later.
- **The spawn loop gains one check**: after each spawn, if the call's signal is already aborted, stop launching. Children that were launched keep their Labels; requests never launched release theirs through the existing path.
- **A new ending joins the outcome vocabulary**: `interrupted`. It is distinct from `cancelled` (pane vanished), carries no summary, and is not a tool error. Its shape alongside the existing endings:

  ```ts
  | { kind: "interrupted" }
  ```

  The watcher produces it exactly where it produces `cancelled` for an aborted wait today; `cancelled` keeps only the vanished-pane case.
- **No summary is scraped for an interrupted child**, even though the session record may hold partial assistant text. A human cut the turn; half a report read as a report is worse than none.
- **The rendered line** for an interrupted child states the ending and the pane's fate — the turn was stopped and the pane was left open — replacing a `cancelled` line that today claims a pane was closed when it was not.
- **Label lifecycle is untouched.** Release on settle stays, including on an interrupted wait: a Label guards against duplicate Labels, not against a child that may take another moment to come to rest.
- **Abort source is not distinguished.** Every abort of the call's signal relays the interrupt, because the extension cannot tell an Esc from a shutdown and every one of them means the same thing to the children.
- **No child-side code and no new settings.** The relay is plain Esc into a pane, which the child's own harness already understands as an interrupt; nothing is added to the launch path, the brief, or the configuration.
- **Docs move with the code**: a new ADR records that interrupt propagates and why; ADR 0001's consequence sentence is amended to point at it; the glossary gains the relayed sense of **Interrupt** and **Interrupted** as an outcome beside **Cancelled**; the README states that Esc stops the whole batch.
- **No new seams.** The fan-out is exercised through the call's existing execution seam with a fake herdr binary that logs argv, the classification through the watcher's existing injectable pane probe, and the wording through the existing render tests.

## Testing Decisions

- **Only external behaviour is asserted**: the commands herdr actually received, the tool result's text and status, the returned endings, and whether a pane was closed. Never a module's internal bookkeeping, never a mocked decision.
- **The primary seam is the tool call itself**, driven end-to-end with a fake `herdr` binary on the environment's bin path — the seam that already covers spawning, closing and layout. One arm is added to that fake for the interrupt command; nothing is injected into the watcher's dependencies.
- **Classification is tested at the watcher's existing injected-probe seam**, which already builds a fake child out of sidecar files: an aborted wait must yield `interrupted` with no summary, leaving `cancelled` to the vanished-pane case.
- **Rendering is tested through the existing result renderer**, asserting the interrupted line and that it no longer says a pane was closed.
- **Prior art**: the existing test *"aborting the call cancels the batch and leaves the pane open"* is the direct ancestor — it already asserts that no `pane close` is issued on abort; it is rewritten to expect `interrupted` and to assert one `pane send-keys <pane> esc` per live child.
- **Coverage required**: one Esc relays to every live child; a child of an earlier call still live is included; an idle child is relayed to as well; no `pane close` is ever issued on this path; no Esc is relayed for a pane that no longer exists; an interrupt mid-spawn leaves the remaining requests unlaunched and their Labels free; the result carries `interrupted` rows, no summaries, and no error status.
- **A new phase in the interrupt smoke script** interrupts from the orchestrator's pane against a real herdr: every child pane shows a stopped turn, the call returns with interrupted children, and every pane is still open. This is the only test that exercises typing into another pane for real.
- **The suite and the type check run green** — the unit tests plus the existing smoke scripts that the change could disturb.

## Out of Scope

- Cascading the interrupt into grandchildren. A subagent cannot spawn subagents, so there is no tree to walk; nothing is built for a depth that does not exist.
- Escalating to closing panes, killing children, or a second-Esc "hard stop".
- Interrupting only the children that are provably mid-turn.
- Salvaging partial text from an interrupted child's session record.
- Changing when Labels are reserved or released.
- Changing how a report, an exit, a settle, a refusal, or a vanished pane ends a wait.
- Any child-side protocol, sentinel file, or new setting.
- Interrupting the orchestrator from a child, or any other direction.

## Further Notes

- **This contradicts a stated consequence of ADR 0001** ("interrupting the orchestrator's turn ends the wait as `cancelled` and never closes a child's pane"). The no-closing half stands and is reaffirmed; the "ends the wait as `cancelled` and nothing else" half is reversed. Flagged here rather than silently overridden, and worth an ADR of its own.
- The awkward part of the feature is that it reaches into a pane the operator may not be looking at, using the same keystroke the operator would use by hand. The mitigation is not targeting cleverness: it is that the relay stops a turn and closes nothing, so the worst case is a child that has to be re-prompted.
- `cancelled` is currently rendered as "cancelled (pane closed without reporting)" and is already wrong on the abort path today; this change removes the lie rather than spreading it.

## Outcome

All five tickets resolved on the single integration branch `integration/interrupt-propagates`, off `main` at `eef3b20`, tip `f947660`. One interrupt in the orchestrator's pane is relayed into every live sub pane this registration holds, the blocking call returns at once, each child's turn stops where it is and is reported `interrupted` with no summary, and nothing is closed. Merge commits: `61c8755` (01), `f79a8f4` + `491b91e` (02 + alignment), `610455f` (03), `5a61f12` (04), `e385e8f` (05), `eb94acd` (review fixes). `npm test` 534 pass / 0 fail, `npm run typecheck` clean at the tip.

## Revision (2026-11-13)

This spec was resolved before the operator reversed the leave-open rule. Wherever the text above says an interrupted pane is left open, visible, or available to read and redirect — the Solution paragraph, user stories 4 and 13, the rendered-line decision, the render-test decision, the "no `pane close`" coverage line, the pane-remains-open smoke requirement, the "escalating to closing panes" out-of-scope line, both Further Notes bullets (the claim that ADR 0001's no-closing half stands, and the "closes nothing" mitigation), and the Outcome sentence — that is superseded by this revision and kept only as the record of what was first decided. `Status: resolved` still holds.

An interrupt now closes the panes it stopped. The relay still types one Esc into every live sub pane this registration holds, the call still returns at once, and each child is still reported `interrupted` with no summary; its pane is then closed, and that is what lets the batch return without waiting on a stopped child — nothing is left running behind the result. A session shutting down under a wait still leaves every pane open, and the outcome now says which of the two happened: the pane was closed, or it was left open. Nothing else moves: the batch-wide scope, the silent best-effort relay, the immediate return, the mid-spawn abort, and the refusals to escalate, to cascade into grandchildren, and to salvage partial text all stand.

The trade-off the reversal buys is added rather than replacing the old one: an operator still cannot stop only the orchestrator and let the children run on, and now the interrupted child's pane is gone, so it cannot be read or redirected afterwards — the cheapest recovery is to re-run the task.

Superseded acceptance lines, by ticket: ticket 02's "no `pane close` and no process kill happens anywhere on this path"; ticket 03's "the panes were left open" result text, its "neither a closed pane nor a Report" rendering line, and the left-open wording in its `## Answer`; ticket 04's "every pane remains open" line and the stopped-turn proof that depended on the pane surviving; ticket 05's refusal-to-close line for the new ADR. Ticket 01 is untouched, as is ticket 03's classification line. `docs/adr/0002-interrupt-propagates.md`, `docs/adr/0001-blocking-tool-result.md`, `GLOSSARY.md` and `README.md` are revised in the same pass.
