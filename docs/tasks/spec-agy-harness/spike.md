# Spike S0: agy harness feasibility

Date: 2026-10-14. agy version pinned: **1.3.4** (`agy --help` banner, `~/.gemini/antigravity-cli/log/*`). Account: Google AI Plus. All runs in `/tmp/agy-spike/`.

## S1 — `-i` stays interactive; model and effort pinned → **PASS**

- `agy models` lists `gpt-oss-120b-medium` as display name "GPT-OSS 120B (Medium)". The exact `--model` string is **`gpt-oss-120b-medium`** — effort is encoded in the model string.
- `--effort` is accepted **only when it matches the model's encoded level**: `--model gpt-oss-120b-medium --effort medium` works; `low`/`high` fail at startup with
  `error: invalid model selection (...): --model gpt-oss-120b-medium conflicts with --effort=low` and **exit code 1** (no TUI opens). Omitting `--effort` is fine.
  - C4 implication: never send an `--effort` that conflicts with the model string; a conflict is a fast non-zero startup failure (feeds C8's preflight row).
- Live pty test (`expect`, `s1-interactive.exp`): `agy -i "<prompt>"` prints the first reply and **stays at the prompt**; a second prompt is answered (`TURN_TWO_OK` seen). Process only exits on `/quit`.
- Evidence: `/tmp/agy-spike/s1-output.log`, `/tmp/agy-spike/s2s3.out`.

## S2 — Stop hook stdin payload → **PASS**

Stop hook receives the documented JSON on stdin (live capture, `/tmp/agy-spike/hooktest/stop-payload.json`):

```json
{
  "artifactDirectoryPath": "~/.gemini/antigravity-cli/brain/<id>",
  "conversationId": "8856396f-...",
  "error": "",
  "executionNum": 1,
  "fullyIdle": true,
  "modelName": "gpt-oss-120b-medium",
  "terminationReason": "NO_TOOL_CALL",
  "transcriptPath": ".../brain/<id>/.system_generated/logs/transcript_full.jsonl",
  "workspacePaths": ["/private/tmp/agy-spike/hooktest"]
}
```

Both required fields (`conversationId`, `transcriptPath`) are present. Note the transcript filename is `transcript_full.jsonl` (docs say `transcript.jsonl`).

## S3 — `decision: "continue"` re-enters the loop → **PASS**

Hook script returned `{"decision":"continue","reason":"You are not done. Reply with exactly CONTINUED_OK, then stop."}` on the first stop and `{}` on the second. Observed live: the reason was injected as a system message ("The user gave a system message instructing to reply with CONTINUED_OK…"), the model answered `CONTINUED_OK`, the hook fired a second time (counter file = 2), and the `{}` stop let the session idle at the prompt. Hook counter file per conversation id works as the C6 design assumes.

## S4 — per-run hook scope → **PASS** (with two constraints)

- agy resolves `hooks.json` from the **workspace** (cwd): a `.agents/hooks.json` in the cwd was loaded — log line `hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)`. Other search paths in the binary: `~/.gemini/config/hooks.json`, `~/.gemini/antigravity-cli/hooks.json`.
- Byte-identity guard: `find ~/.gemini/config ~/.agents -type f | xargs shasum` before and after the live run — **identical**. The hook was served entirely from the run dir.
- **Constraint 1 (trust):** the first run in a fresh cwd shows a trust dialog ("Yes, I trust this folder"); hooks were not loaded until trust was resolved, so the first turn's stop did not fire the hook. Trust persists in `~/.gemini/antigravity-cli/settings.json` → `trustedWorkspaces`. C7 must cd the child into a per-run dir **and** pre-add it to `trustedWorkspaces` (a write outside the run dir — the C7 guard's scope must be agreed: settings.json is touched once per run dir, or the run dir reuses a trusted parent). Flag this to the user at C7 review.
- **Constraint 2 (cwd):** tinysubagent children currently run with `cwd: context.cwd` (the project dir). Per-run scope therefore requires the launch script to `cd` into a per-run dir before exec'ing agy (matches how the launch script already does `cd <cwd>`). `.agents/hooks.json` in that dir is per-run and deletable with the run dir.

## S5 — transcript parseable for last assistant text → **PASS**

`transcriptPath` is NDJSON; each line has `type`, `source`, `status`, `content`. Last assistant text = last entry with `type == "PLANNER_RESPONSE"` and `status == "DONE"` → `.content` (verified: `"content": "CONTINUED_OK"`). `readTurn` implementation is trivial. If the file is missing/empty → return null (per plan).

## Additional findings for later tasks

- Startup config errors (e.g. effort/model conflict) exit **1 before any TUI** — usable as preflight signal (C8 row: missing binary / bad args → `failed` before pane opens; note this error happens after pane open in interactive mode, so C8's preflight should validate argv before spawn).
- Hooks log source: `hooks_manager.go`; useful for debugging ("loaded N named hooks from M hooks.json file(s)").
- Hook command runs as a plain shell command; `timeout` field exists per hook.

## Verdict

S1–S5 all pass. The original isolated-workspace design was implemented and manually verified. The later project-directory amendment has a separate A1 result below; it is blocked and must not be implemented under the current requirements.

## A1 — project-cwd hook-preservation amendment → **BLOCKED**

Investigation date: 2026-10-14. agy version: **1.3.5**.

- agy loads project hooks from a single `<cwd>/.agents/hooks.json`; hook definitions are named top-level entries and handlers for matching events are merged and run sequentially. The hook command's working directory is the directory containing that file. The installed agy hooks guide documents no include, overlay, per-process hook-file override, or dynamically supplied hook mechanism.
- Therefore adding a per-run Stop hook to an existing project hook file requires editing the shared project file. A read/merge/write/restore sequence cannot guarantee exact preservation under overlapping runs or external edits. Locking only tinysubagent runs does not protect against arbitrary project tooling, and a lock cannot guarantee cleanup after SIGKILL, machine failure, or power loss. Restoring a captured backup in those cases could overwrite legitimate concurrent changes; leaving the injection behind violates byte-identical cleanup and leaks a stale run-specific hook.
- For a missing file, atomic creation and cleanup still leaves stale state after uncatchable termination and risks deleting a file another actor created or modified in the meantime. Malformed/unsupported existing JSON cannot be safely merged and must not be overwritten.
- The isolated workspace used by the original C7 design avoids modifying project hooks, but it violates the approved amendment's requirement that agy run with the project directory as cwd and preserve existing project-hook behavior.

**Decision:** no strategy was found that meets all amendment guarantees (project cwd, existing hooks active, exact restoration, overlapping runs, external changes, abnormal termination). Per the task's stop condition, do not implement A2 or claim the amendment is verified. A future design needs an agy-supported per-run hook overlay/configuration mechanism, or a revised requirement that permits durable per-run project hook state and defines crash/concurrency recovery. No live model run was attempted; this is a hook-configuration lifecycle blocker, established from the installed agy hook contract and current launch model.
