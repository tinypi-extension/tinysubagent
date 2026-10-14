# Spec: a profile can choose the child CLI (pi or agy)

Status: **approved, Q1–Q4 decided (2026-10-14).** No code until the spike (Phase 0) is recorded in `docs/tasks/spec-agy-harness/spike.md`.

Builds on `docs/specs/spec-report-required.md` (the report is the only clean ending) and
`docs/specs/spec-child-preflight-failure.md`. Does not change the sidecar contract.

## Assumptions I'm making

1. A profile names one harness (`pi` or `agy`) plus that harness's own model and effort/thinking keys. Harness absent means `pi`, so existing configs do not change.
2. `agy` children run **interactively in a herdr pane** (no `-p`). The pane is the only place a human can see, approve, or steer the child.
3. The child's report is written to the existing sidecar `$PI_TINYSUBAGENT_REPORT` with the existing JSON shape. No new keys.
4. The orchestrator's own session stays pi. Only the child CLI changes.
5. The watcher needs no new state. Its existing classification (report > settle > exit sidecar > pane liveness) covers agy.

## Test model

Real agy runs use `gpt-oss-120b`. This is the chosen test model because the developer's testing is blocked on another model, not because of a product rule: profiles keep choosing their own model. Google's models page lists GPT-OSS-120b on Free, AI Plus, AI Pro, and AI Ultra (not Enterprise) and marks it for removal on 2026-11-02, so the real-run gate must pass before then or the test model is re-pinned. Unit tests never call a model.

## Objective

Let one profile launch a child in `agy` (Google Antigravity CLI) and get back the same
outcome a pi child gives: a `subagent_report` result, a failure with a reason, or a pane held
open for a human. Pi stays the default and its behaviour does not change.

**Why now:** the seams are already isolated (5 pi-coupled files, see recon). The adapter
boundary is the cheapest point to add a second CLI before more pi assumptions spread.

## Config

```jsonc
"profiles": {
  "fast-pi":   { "harness": "pi",  "model": "...", "thinking": "medium" },
  "gemini":    { "harness": "agy", "model": "...", "effort": "low" }
}
```

| Key | Valid for | Behaviour |
|---|---|---|
| `harness` | all | `"pi"` (default) or `"agy"`. Any other value: profile dropped, warning at load (fail closed; never run an unknown CLI). |
| `model` | all | Passed through to the harness. Not validated across harnesses. |
| `thinking` | `pi` | As today. |
| `effort` | `agy` | `low` / `medium` / `high`, passed as `--effort`. |
| `thinking` on `agy` | — | Ignored with a warning, the same pattern as today's unknown-`thinking` warning (`config.ts:198`). |
| `effort` on `pi` | — | Ignored with a warning. |

Tool allowlist (decided, Q1): an allowlist is not a profile key. It comes from the agent role's `tools` frontmatter (`spawn.ts:72-88`). When the resolved harness is `agy` and the role has a non-empty `tools` list, `spawnOne` refuses the spawn with a clear error before the pane opens: agy has no flag that enforces the list, and a child must never run wider than its role says. A role with no `tools` frontmatter is allowed on agy, since it already means "no restriction" and that is unchanged.

Spawn error: `agent "<name>" declares tools, which the agy harness cannot enforce. Remove the tools list or use a pi profile.`

Binary: `TINYSUBAGENT_AGY_BIN` env override, mirroring `PI_HERDR_PI_BIN`. Default `agy`.
No binary key in config.

## Architecture

New module `src/children/harness/`:

```
interface ChildHarness {
  id: "pi" | "agy";
  resolveBin(env, profile): string;
  buildArgv(spec): string[];              // prompt delivered as a file, never inline
  supportsExtension: boolean;             // pi: true (-e child.ts); agy: false
  sessionFileFor(cwd, agentDir): string;  // pi: today's path; agy: transcript path (see Phase 0)
  readTurn(file): TurnInfo | null;        // null = report-only, no result scrape
  readRefusal(...): Refusal | null;       // pi: preflight.ts; agy: always null in v1
}
```

- `pi` adapter = today's code moved behind the interface. No behaviour change.
- `agy` adapter = new. Its settle path is the **Stop hook**, not `agent_settled`.

`spawn.ts` resolves the profile's harness and passes the adapter to `launch-script.ts`.
`watcher.ts`, `report.ts`, `herdr/*`, `herdr-plugin/*`, `present/*` are unchanged.

## agy child lifecycle

1. Spawn: `launch-script.ts` writes the same wrapper as today. It exports `PI_TINYSUBAGENT_*`
   and runs `agy --model <m> --effort <e> -i "<task file contents>"` (exact flags pinned in Phase 0).
2. The task markdown tells the child to write its final report to `$PI_TINYSUBAGENT_REPORT`
   as `{"type":"done","result":"..."}` or `{"type":"failed","reason":"error","message":"..."}`,
   via a temp file then rename (atomic).
3. **Stop hook** (`agy` `Stop` event) runs `agy-stop-hook` with the stdin payload.
   - Sidecar present and valid JSON: hook outputs `decision: "allow"` (any non-`continue` value). Agent stops. Pane stays at prompt until the watcher closes it (report).
   - Sidecar missing, first stop of this conversation: hook outputs `decision: "continue"` with `reason` = "Call the report now: write your final report to $PI_TINYSUBAGENT_REPORT." The agent gets one more turn.
   - Sidecar missing, second stop of this conversation: hook allows the stop. Nothing is written. Per `spec-report-required`, the pane stays open and the batch waits for a human.
4. Nudge count is kept per conversation id in `<artifactDir>/context/` (a small counter file). Hard cap: 1 nudge (decided, Q3). No unbounded loop.
5. Process exit: the wrapper writes the exit sidecar as today. Non-zero = `failed / exit` (watcher, unchanged). Exit 0 with no report: the agy wrapper writes `{"type":"failed","reason":"no-output"}` to `$PI_TINYSUBAGENT_REPORT` **before** the exit sidecar, only if no report exists yet (decided, Q4). The watcher's existing report branch then classifies it as `failed / no-output`. The watcher is not changed.

Outcome table, agy:

| Signal | Outcome | Pane |
|---|---|---|
| report sidecar `done` | completed / report | closed |
| report sidecar `failed` | failed / reason | left open |
| agy process exits 0 with no report | `failed / no-output` via wrapper-written report sidecar (decided, Q4) | left open |
| agy process exits non-zero | failed / exit | left open |
| agy process exits 0 with a report | completed / report (report wins; the exit sidecar is ignored) | closed |
| unreported stop, after the one nudge | nothing written, batch waits | open |
| pane closed by hand | cancelled | — |

## Boundaries

- **Always:** keep the sidecar byte-compatible. Write via temp + rename. The hook validates JSON before it allows a stop. Run `npm run typecheck` and `npm test`.
- **Always:** the hook is scoped to the child run. The user's global agy config is not modified (checked by diff before and after a run).
- **Ask first:** any change to the pi path beyond moving it behind the interface; any new sidecar key; an unbounded nudge; a global hook install.
- **Never:** pass the task prompt inline on argv or via env (it stays in a file, as today). Never let an unknown `harness` value fall back to pi silently. Never make the Stop hook block forever.

## Phase 0: spike (gates the implementation plan)

Each item must pass or the design changes. Results go to `docs/tasks/spec-agy-harness/spike.md`.

| # | Question | Pass condition | Known so far |
|---|---|---|---|
| S1 | Does `agy -i "<prompt>"` start an interactive session that stays at the prompt after the task? | Pane stays alive after the first turn. | Unverified. Headless `-p` exists; `-i` reported in docs. |
| S2 | Stop hook payload: `conversationId`, `transcriptPath`, last message? | Hook can read `conversationId` and `transcriptPath` from stdin. | Verified in docs: common fields include `conversationId`, `transcriptPath`, `artifactDirectoryPath`. |
| S3 | Can a Stop hook force one more turn? | `decision:"continue"` + `reason` re-enters the loop. | Documented: `continue` re-enters the execution loop; `reason` is injected as a system message. Needs a live test. |
| S4 | Per-run hook scope: can the child load hooks without touching the user's global config? | A hook file passed by flag or env var, or a project-local file in the child's own cwd that we remove after the run. | **Unverified. Blocking.** |
| S5 | Is `transcriptPath` a readable format we can parse? | `readTurn` can extract last assistant text. If not, `readTurn` returns null and agy completes report-only. | Unverified. Not blocking. |

If S3 or S4 fails, stop and return to the user before writing the plan. Do not fall back to
global hooks without approval.

## Success criteria

1. A profile with no `harness` launches exactly the argv it launches today. Existing `test/children/*` and `test/config/*` pass without edits to their expectations.
2. `harness: "agy"` builds argv with `--model`/`--effort`, the prompt as a file, and no `-p`. Unit-tested.
3. Unknown harness value drops the profile with a warning. `thinking` on agy and `effort` on pi are ignored with a warning. Unit-tested.
4. Unreported agy stop: hook nudges once, then allows the stop; no sidecar written; pane open. Tested with a stub agy that scripts the hook calls.
5. A real agy child in a herdr pane calls the report: watcher emits `completed / report`, pane closes. Smoke test, run manually once.
6. Global agy config (`~/.gemini/config/hooks.json` and `~/.agents/`) is byte-identical before and after an agy run.
7. Missing agy binary: failed with a message before the pane opens, following `spec-child-preflight-failure`.
8. `npm run typecheck` and `npm test` pass.

## Decisions (resolved)

1. **Tool allowlist → reject on agy.** See Config. Refusal at spawn, before the pane opens.
2. **Tool approval prompts → the human approves in the pane.** Default. `--dangerously-skip-permissions` is not implemented in v1; a per-profile opt-in key can be a follow-up spec.
3. **Nudge count → 1.** One `continue` from the Stop hook, then allow.
4. **Exit 0 with no report → `failed / no-output`.** An agy child that ends without a report is a failure, not a silent completion. Implemented in the agy wrapper only, which writes the failed report sidecar before the exit sidecar. The watcher is unchanged. The pi path keeps its `session-exit` completion.

## Files

| File | Change |
|---|---|
| `src/config/config.ts` | parse `harness`, `effort`; warnings for wrong-harness keys; drop unknown harness |
| `src/config/profiles.ts` | `Profile` gains `harness`, `effort`; tool description text (`:54-61`) lists the harness |
| `src/children/harness/types.ts` | new: `ChildHarness` |
| `src/children/harness/pi.ts` | new: today's pi code moved here |
| `src/children/harness/agy.ts` | new: agy argv, bin, session path, `readTurn` |
| `src/children/harness/index.ts` | new: `harnessFor(profile)` |
| `src/children/launch-script.ts` | `buildPiArgv`/`resolvePiBin` become harness calls |
| `src/children/spawn.ts` | resolve harness; preflight failure for missing binary; refuse agy spawns that declare `tools` |
| `src/children/agy-stop-hook.ts` | new: Stop hook; nudge counter; JSON check |
| `src/children/task-markdown.ts` | report instruction per harness (pi: tool; agy: sidecar write) |
| `src/paths.ts` | path to the hook script |
| `test/children/harness-*.test.ts` | new: argv, nudge logic, outcome table |
| `test/config/*` | new cases for `harness`, `effort`, warnings |
| `docs/tasks/spec-agy-harness/spike.md` | spike results (Phase 0) |
| `AGENTS.md` | spec-memory index entry for this spec |

Not changed: `watcher.ts`, `report.ts`, `herdr/*`, `herdr-plugin/*`, `present/*`, `pi/watch-batch.ts`, `spec-report-required` behaviour.
