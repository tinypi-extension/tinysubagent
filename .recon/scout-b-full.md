# HERDR RECIPE (from pi-herdr-subagents)

All refs are `/Users/tinyphat/Project/pi-herdr-subagents-main/` unless noted. herdr 0.8.2 verified installed at `~/.local/bin/herdr`; CLI surfaces quoted from live `--help` output.

## 1. HERDR DETECTION

Two layers — activation gate then capability probe.

**Activation gate** — `index.ts:196-198`:
```typescript
export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}
```
herdr injects into every pane. Verified live in this very pane's env:
```
HERDR_ENV=1
HERDR_PANE_ID=w7:p25
HERDR_SOCKET_PATH=/Users/tinyphat/.config/herdr/herdr.sock   (named sessions get their own socket — docs/full-socket-client.md:23)
```

**Capability probe** (only when a spawn is attempted, cached per session) — `index.ts:133-152` (`checkHerdrCapability`):
1. `herdr status server --json` (plain JSON, not envelope; exits 0 whether or not server runs). Requires `running === true` and `versionAtLeast(version, "0.8.2")` (`MIN_HERDR_VERSION`, `client.ts:40`).
2. `herdr plugin list --plugin pi-herdr-subagents --json` → must find plugin, `enabled === true`.

**Tool registration gate** — `index.ts:1102-1110`: real tools register at load only if `isInsideHerdr()`; outside, setup-hint stubs register at `session_start` only if no other extension provides a `subagent` tool. Also respects `PI_DENY_TOOLS` for per-agent tool denial.

## 2. PANE CREATION

One command, built in `src/herdr/client.ts:156-186` (`paneStart`). Exact argv:
```
herdr plugin pane open
  --plugin pi-herdr-subagents
  --entrypoint subagent
  --placement split
  --target-pane <HERDR_PANE_ID>        # orchestrator's own pane (env.HERDR_PANE_ID, launch.ts:468)
  --direction right                    # RIGHT-hand pane (hardcoded in launch.ts paneStart)
  --cwd <effectiveCwd>
  --env PI_HERDR_LAUNCH_SCRIPT=<abs path to generated launch script>   # any extra env also via --env KEY=VALUE
  --no-focus
```
Live help confirms flags: `--plugin`, `--entrypoint`, `--placement [overlay|split|tab|zoomed]`, `--target-pane`, `--direction [right|down]`, `--cwd`, `--env KEY=VALUE`, `--focus/--no-focus`.

Response parsing: JSON envelope `{ id, result: { plugin_pane: { pane: { pane_id, terminal_id, workspace_id, tab_id }}}}`; `pane_id` is the persisted handle stored in the `RunningSubagent` map. Then best-effort:
```
herdr pane rename <paneId> <label>          # client.ts:195-199 (exit-0 only, shape not relied on)
```
No size/ratio is set anywhere — UNKNOWN/absent. `--no-focus` keeps orchestrator focus.

## 3. CHILD LAUNCH

**Not typed, not a shell** — argv-exec chain, "no launch race by construction" (README, CORE_PRINCIPLE.md:51-54).

Chain (`CORE_PRINCIPLE.md` §4.3): `plugin pane open` → herdr runs the plugin's fixed dispatcher → dispatcher `exec bash <launch script>` → script runs pi.

**Dispatcher** — `herdr-plugin/dispatch.sh` (verbatim):
```bash
#!/usr/bin/env bash
set -u
launch_script="${PI_HERDR_LAUNCH_SCRIPT:-${PI_SUBAGENT_LAUNCH_SCRIPT:-}}"
if [[ -z "$launch_script" ]]; then echo "...PI_HERDR_LAUNCH_SCRIPT is unset..." >&2; exit 64; fi
if [[ ! -r "$launch_script" ]]; then echo "...not readable..." >&2; exit 66; fi
exec bash "$launch_script"
```
herdr passes `PI_HERDR_LAUNCH_SCRIPT` (set via `--env` in the open command) plus `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_ENTRYPOINT_ID`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_CONTEXT_JSON` into the pane (all verified live).

**Generated launch script** (`src/launch.ts:249-295` `buildWrapperScript`) — the single place env/wrapping/exit-capture happens:
```bash
#!/usr/bin/env bash
trap '' TSTP                      # argv panes have no parent shell; Ctrl+Z would wedge the pane
# Subagent launch script for <name> / Generated / Session headers
export PATH='<orchestrator PATH>'                       # curated, never full env dump
export PI_CODING_AGENT_DIR='<local .pi/agent or inherited>'
[export PI_DENY_TOOLS=... if deny-tools]
export PI_SUBAGENT_NAME='<name>'
export PI_SUBAGENT_AGENT='<agent>'                      # if agent param
[export PI_SUBAGENT_AUTO_EXIT=1 if autoExit]
export PI_SUBAGENT_SESSION='<child session file>'
export PI_SUBAGENT_ID='<run id>'
export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"            # forward herdr's injected pane id
cd '<effectiveCwd>'
[<launchPrefix> ]'<piBin>' '--session' '<sessionFile>' '-e' '<subagent-done.ts>' \
   [--model '<model[:thinking]>'] [--tools '<allowlist>'] [--system-prompt '<file>'|--append-system-prompt '<file>'] \
   ['/skill:<x>' ...] '<task | @taskfile.md>'
code=$?
echo "$code $PI_SUBAGENT_ID" > '<sessionFile>.exitcode'
if [ "$code" -ne 0 ] && [ "$SECONDS" -lt 15 ]; then echo "subagent crashed..."; read -r; fi
exit "$code"
```
- direnv handling: if effective cwd or ancestor up to $HOME has `.envrc` → prefix `direnv exec '<cwd>'` (`launch.ts:222-239` `resolveLaunchPrefix`/`hasEnvrc`). This is how the "direnv swallows typed command" failure is avoided: the wrap happens inside the script before pi runs, and nothing is typed into an interactive shell. Overrides: `PI_HERDR_LAUNCH_PREFIX` (template, `{cwd}` interpolated, even empty string disables), `PI_HERDR_DIRENV=0`.
- System prompt is passed **as a file path** (`--system-prompt <file>` / `--append-system-prompt <file>`), "pi's flags auto-detect file paths, avoiding shell escaping issues with multiline content" (`launch.ts:396-406`).
- Model: `--model <model>` or `--model <model>:<thinking>` when agent def has `thinking` (`launch.ts:384-386`).
- Task: fork mode → direct text arg; standalone/lineage → task written to `<artifactDir>/context/<name>-<ts>.md`, child gets `@<taskfile>` as initial message. `/skill:` prompts become separate positional args after an empty first positional when artifact-delivered (`buildPiPromptArgs`, `launch.ts:110-135`).
- Child verification: **none needed** — there is nothing to verify; crash detection is via the exitcode sidecar + startup window (`launch.ts` header: "There is no verify/retry machinery because there is nothing to verify").

**pi argv summary**: `[piBin, --session <sessionFile>, -e <subagent-done.ts>, (--model m[:thinking]), (--tools list), (--system-prompt file), ""?, /skill:…?, task|@taskfile]`. `piBin` = `PI_HERDR_PI_BIN` else first executable `pi` on env.PATH scanned for X_OK (`launch.ts:213-220`).

## 4. THE HERDR PLUGIN

**`herdr-plugin/herdr-plugin.toml`** (verbatim):
```toml
id = "pi-herdr-subagents"
name = "Pi Herdr Subagents"
version = "0.2.0"
# v0.8.2 is the first known-good release with split plugin panes.
min_herdr_version = "0.8.2"
description = "Launch pi subagents in Herdr panes"
platforms = ["linux", "macos"]

[[panes]]
id = "subagent"
title = "Pi subagent"
placement = "split"
# --cwd overrides the pane's working directory, so resolve the versioned
# dispatcher from Herdr's protected plugin-root environment and exec it.
command = ["bash", "-c", "exec bash \"$HERDR_PLUGIN_ROOT/dispatch.sh\""]

[[panes]]
id = "argv"
title = "Command"
placement = "split"
command = ["bash", "-c", "exec bash \"$HERDR_PLUGIN_ROOT/dispatch.sh\""]
```
It is **not** a pubsub/event plugin — it defines pane *templates* only. It subscribes to nothing; there is no plugin event transport. All events come from herdr's own socket API (§5). The plugin's only job: provide `plugin pane open` entrypoints that exec the versioned dispatcher with `HERDR_PLUGIN_ROOT` (herdr's protected copy of the plugin dir) so the dispatcher can't be cwd-shadowed (toml comment).

**Registration path** (verified on this machine): installed by symlinking the repo's plugin dir:
```
herdr plugin link "/path/to/pi-herdr-subagents/herdr-plugin" --enabled
herdr plugin enable pi-herdr-subagents
```
State on disk: `~/.config/herdr/plugins.json` (verified live) records:
```json
{"plugin_id":"pi-herdr-subagents", "manifest_path":"/Users/tinyphat/.pi/agent/extensions/subagent/herdr-plugin/herdr-plugin.toml",
 "plugin_root":"/Users/tinyphat/.pi/agent/extensions/subagent/herdr-plugin", "enabled":true, "source":{"kind":"local"}, ...}
```
The extension's error message tells the user exactly this (`index.ts:143-149`, `HERDR_PLUGIN_DIR = <package root>/herdr-plugin`).

## 5. COMPLETION + RESULT TRANSPORT

**Two sidecar files next to the child session file** (contracts — "do not rename", `watcher.ts:15-21`, `subagent-done.ts:13-19`):
- `<sessionFile>.exit` — written by the child extension `subagent-done.ts` (`writeExitSidecar`, byte-shape fixed):
  ```json
  {"type":"done"}
  {"type":"ping","name":"...","message":"..."}
  ```
- `<sessionFile>.exitcode` — written by the wrapper script: `"<exitCode> <PI_SUBAGENT_ID>"` (run-id stamps ownership so resume races can't mistake stale sidecars).
- (optional `<sessionFile>.context-usage` — telemetry snapshot `{version:1, subagentId, tokens, contextWindow, percent}`, atomic rename publish, `context-usage.ts`.)

**Completion detection** (`src/watcher.ts`) — three signal sources, first wins:
(a) **Socket event stream** (`src/herdr/events.ts`): persistent raw ndJSON unix socket to `HERDR_SOCKET_PATH`:
  → `{"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"}]}}\n`
  ← `{"id":"sub1","result":{"type":"subscription_started"}}`
  ← `{"data":{"pane_id":"w1:p4","type":"pane_exited","workspace_id":"w1"},"event":"pane_exited"}`
  Note: `pane.exited` carries **NO exit code**; no replay (reconnect → reconcile hook → `pane list`/`pane get` gap check). Backoff 500/1000/2000/5000ms.
(b) **fs.watch + 5s slow poll** on the session dir for the sidecar files (the only signal when startup-crash hold-open keeps the pane alive).
(c) **Reconcile** after resubscribe → pane-existence check (`pane-killed` vs `gap-exit` classification).

**Classification matrix** (`watcher.ts:185-260`): `.exit` done→`completed`; ping→`ping`; exitcode 0 no `.exit`→`completed-user-exit`; exitcode≠0 within 15s + empty session→`launch-failed` (heldOpen); exitcode≠0 later→`crashed`; pane event, no sidecars→`pane-killed`; gone during stream gap→`gap-exit`. Watcher **consumes (rmSync) both sidecars** on resolution.

**Final text**: the orchestrator reads the child's **session .jsonl** (`findLastAssistantMessage`, `session.ts:126-143`) — last entry with `type:"message"`, `message.role:"assistant"`, joining `content[].type==="text"` blocks. So the result is **full text extracted from the session file**, not a pointer. Steer message (`pi.sendMessage(..., {triggerTurn:true, deliverAs:"steer"})`, `index.ts:419-428`) has `customType:"subagent_result"` with `details: {name, task, agent, elapsed, sessionFile, sessionId, paneId, disposition, exitCode, summary, ...}` (`messages.ts`). "Session:" line offers the canonical UUID from the session header (`getSessionId`).

## 6. PANE CLOSE

```
herdr pane close <paneId>      # client.ts:220-222 (JSON envelope, execHerdrJson)
```
Panes **auto-close on clean exit** (the wrapper just exits; herdr closes exit-0 panes) — the extension calls `paneClose` only in the test seam paths; normal flow relies on natural close. On startup crash: wrapper hold-open (`read -r`, default 15s, `PI_HERDR_HOLD_OPEN_SECS`) keeps the pane for post-mortem; "press Enter to close". External kill: no cleanup — watcher classifies `pane-killed` from the pane event and reports. Interrupt uses `herdr pane send-keys <paneId> esc` (key-combo syntax; note `pane send-keys` prints nothing on success — exit code only, `client.ts:225-229`).

## 7. FRAGILITY (must not re-derive naively)

1. **min_herdr_version = 0.8.2** — "v0.8.2 is the first known-good release with split plugin panes" (toml line 4). Capability check enforces it.
2. **`pane.exited` carries no exit code; pane records vanish on exit** (events.ts:15, README "Known limitations") → exitcode sidecar is mandatory. Feature request for `exit_code` drafted in docs/full-socket-client.md — if it lands in a newer herdr, the sidecar can go.
3. **`pane send-keys` prints NOTHING on success** (client.ts:226-229, "verified live against herdr 0.7.1") — only demand exit 0.
4. **`pane rename` output shape not relied on** (client.ts:193-194, "stays compatible across herdr versions") — exit 0 only.
5. **`herdr status server --json` prints plain JSON, not an id/result envelope** (client.ts:233-235).
6. **Launch race / direnv swallowing typed commands** — the historical bug of the reference mux approach (README "Why a separate herdr-native extension", PROJECT-BRIEF.md:17-20: "typed launch commands are *flushed* by direnv/devenv"). Fixed by argv exec; never reintroduce typing.
7. **`trap '' TSTP`** required in argv-launched scripts — no parent shell to `fg` from (README, launch.ts:252-255).
8. **events.subscribe has no replay** — reconcile hook after every resubscribe (events.ts:11-15, watcher source (c)).
9. **Stale-sidecar race on resume** — old exit-0 sidecar landing after clear; guard: sidecar run-id stamp + "exit 0 while our pane still alive cannot be ours" (`watcher.ts:315-345`, CORE_PRINCIPLE §3.4). Also executor must `rmSync <session>.exit/.exitcode` before resume (`launch.ts:497-499`, `index.ts:812-814`).
10. **Protocol-version drift**: full-socket-client.md:75 — "We own protocol-version drift the CLI currently absorbs (request shapes, envelope changes, version negotiation against ping.protocol)". Hybrid client (CLI for request/response, raw socket only for events) is deliberate to absorb drift.
11. **Auto-exit mid-retry bug** (subagent-done.ts:47-52, "verified live, pi 0.80.3"): last-message-is-user check prevents exiting while pi retries.
12. **Tool registry race**: pi resolves duplicate tool names first-loaded-extension-wins, silently (index.ts:7-11) — package order matters; lost race emits visible warning.
13. **Session file format version 3 header is a hard contract** (session.ts:5-7: "do not refactor").
14. **Child must not auto-exit while nested subagents run** (subagent-done.ts:31-33, global `Symbol.for` active-id set, runtime-state.ts).

## 8. TOOL SCHEMA SEMANTICS (spawn path only)

**Single spawn** — `SubagentParams`, `index.ts:452-493` (typebox):
| param | type | notes |
|---|---|---|
| `name` | String (req) | display name, sanitized via `safeName` (lowercase, dashes) |
| `task` | String (req) | prompt/task |
| `agent` | String? | loads frontmatter defaults from `.pi/agents/<name>.md` or `~/.pi/agent/agents/<name>.md` |
| `systemPrompt` | String? | role instructions; with agent def `system-prompt:` frontmatter → file-based `--system-prompt`/`--append-system-prompt` |
| `model` | String? | overrides agent default |
| `skills` | String? | comma-separated; becomes `/skill:x` positional prompts |
| `tools` | String? | comma-separated; overrides agent default |
| `cwd` | String? | child working dir (param > agent def `cwd` > orchestrator cwd) |
| `fork` | Boolean? | force full-context fork mode |
| `interactive` | Boolean? | explicit override; falls back to agent `interactive` frontmatter, else inverse of `auto-exit` (`agents.ts:265-279`) |

Execute flow (`executeSubagentSpawn`, index.ts:551-648): self-spawn block (`PI_SUBAGENT_AGENT === params.agent`) → load agent defs → require parent session file → `ensureHerdrCapability()` → `buildLaunchPlan` → `writePlanFiles` → optional `seedSubagentSessionFile` → `paneStart` → `paneRename` → `armWatcher`. **Fire-and-forget**: returns immediately with "started" ack; result arrives later as steer message.

**`autoExit`, `confirmProjectAgents`, `tasks[]`, `profile` are NOT parameters of the spawn tool in this reference.** `autoExit` exists only as (a) agent frontmatter `auto-exit`, (b) `subagent_resume`'s `autoExit` param, (c) `PI_SUBAGENT_AUTO_EXIT=1` env export. `subagent_interrupt` has `id`/`name`. No `tasks[]` array exists anywhere in index.ts (grep verified). **UNKNOWN how a parallel-batch API would look — not implemented here.**

**Parallel**: parallelism is achieved by the model issuing multiple independent `subagent` calls ("including spawning more subagents in parallel", tool description). Each spawn returns an immediate ack; each finished child delivers its own steer message independently, **so results arrive in completion order, not spawn order**, and there is no "wait for all" barrier. Failures are individual steer messages with `disposition`/`details.error` (`launch-failed`/`crashed`/`pane-killed`/`gap-exit`), never exceptions to the batch. Concurrent spawns are safe because each launch computes a deterministic child session path up front (launch.ts:324-340, CORE_PRINCIPLE P8).

## 9. AGENT FILE PARSING

`src/agents.ts:99-141` `parseAgentDefinition` — regex frontmatter (`^---\n([\s\S]*?)\n---`), no YAML lib (compat contract with pi-interactive-subagents). Fields honoured:
```
name, description, model, tools,
system-prompt: append|replace  → systemPromptMode
skill|skills (either key), thinking, deny-tools,
spawning: true|false, auto-exit: true|false, interactive: true|false,
session-mode: standalone|lineage-only|fork, cwd, cli,
disable-model-invocation: true
```
Plus markdown **body** → `AgentDefaults.body`, used as identity: prepended to the task message, or written to a sysprompt file when `system-prompt:` is set (`launch.ts:330-345, 396-406`).

**Precedence**: `loadAgentDefaults` checks `./.pi/agents/<name>.md` **first**, then `<configDir>/agents/<name>.md` (`agents.ts:238-250`) — project overrides root. Config dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Agent-def values are defaults; explicit tool params override (`launch.ts:323-326`: `params.model ?? agentDefs?.model`, etc.). When `cwd` comes from frontmatter, relative cwds resolve against the agent config dir (agents.ts:203-216).

**Tools enforcement — two layers:**
1. Child argv: `buildSubagentToolAllowlist` (`launch.ts:88-107`) builds `--tools "<requested>,caller_ping,subagent_done"` — the control tools are **force-added** because pi 0.70+ `--tools` applies to extension tools too and would otherwise hide them. `subagent_done`/`caller_ping` are defined in `subagent-done.ts`, loaded via `-e`.
2. Spawn suppression: agent def `tools` list is exported as `PI_DENY_TOOLS` (after `resolveDenyTools` expands `spawning:false` to all four spawn tool names, agents.ts:43-64); the child's extension entry checks `PI_DENY_TOOLS` before registering `subagent` etc. (`index.ts:1097-1101`), and the spawn tool is refused if absent. So a `tools: read,bash` child can read/bash but cannot spawn grandchildren.

Example def (agents/worker.md): `name/description/tools: read,bash,edit,write/thinking: medium/spawning: false/auto-exit: true/system-prompt: replace`.

---

## MINIMUM VIABLE CALL SET

Ordered sequence to: detect → open right pane → launch child → detect completion → read final text → close.

**Files needed**: `herdr-plugin/herdr-plugin.toml` + `herdr-plugin/dispatch.sh` (linked+enabled once via `herdr plugin link <dir> --enabled`), a launch-script generator (wrapper script template from §3), a child extension providing `subagent_done`/`caller_ping` writing `<session>.exit`, a watcher (socket + sidecars), and the pi session file for final text.

1. **Detect**: pi running inside herdr pane (`HERDR_ENV=1 && HERDR_PANE_ID && HERDR_SOCKET_PATH`), then
   `herdr status server --json` → check `running:true`, version ≥ 0.8.2; `herdr plugin list --plugin pi-herdr-subagents --json` → `enabled:true`.
2. **Open right pane**:
   `herdr plugin pane open --plugin pi-herdr-subagents --entrypoint subagent --placement split --target-pane "$HERDR_PANE_ID" --direction right --cwd "<childCwd>" --env "PI_HERDR_LAUNCH_SCRIPT=/abs/launch.sh" --no-focus` → parse `result.plugin_pane.pane.pane_id`.
3. **Launch child** (no typing — the plugin dispatcher already `exec`ed it): launch script does `trap '' TSTP`; export PATH + `PI_SUBAGENT_NAME/AGENT/SESSION/ID` (+`PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"`); `cd '<cwd>'`; `[direnv exec '<cwd>' ] <piBin> --session <childSession.jsonl> -e <subagent-done.ts> [--model <m>:<thinking>] [--tools <list>,caller_ping,subagent_done] [--append-system-prompt <sysprompt.md>] '<@taskfile | task>'`.
4. **Detect completion**: subscribe once to `events.subscribe` (`pane.exited`/`pane.closed`) on `HERDR_SOCKET_PATH`, plus fs.watch/poll for `<session>.exit` / `<session>.exitcode`. First signal wins: `.exit` `{"type":"done"}` → completed; ping → help; exitcode → crash/launch-fail matrix; pane event without sidecars → pane-killed. Consume (rm) sidecars on resolve.
5. **Read final text**: parse child `<session>.jsonl` lines; last `type:"message" && role:"assistant"` entry; join its `content[]` text blocks.
6. **Close**: normally automatic (exit 0 auto-closes; pane_id already gone). If needed: `herdr pane close <paneId>`. On startup crash: pane self-holds 15s (`read -r`) then closes.

One-sentence essence: **plugin-defined split pane + fixed dispatcher execing a generated wrapper script (no typing) + exit sidecars for semantics + socket events for liveness + incremental session file for the result.**

<<<BLOCK>>>

I reverse-engineered the full herdr integration recipe from the working reference and delivered it as the compressed doc above, answering all 9 questions with verbatim code, live-verified CLI output, and file:line refs. Key findings: detection is `HERDR_ENV=1` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH` plus a `herdr status server --json` version/plugin probe; pane creation is a single `herdr plugin pane open --entrypoint subagent --direction right --no-focus` call; child launch happens via a generated wrapper script that the plugin dispatcher argv-execs (no shell typing — direnv race impossible by construction); completion is detected from `.exit`/`.exitcode` sidecars plus a raw-socket `events.subscribe` stream; final text is read directly from the child's incremental session .jsonl; and the parallel/tasks[] API asked about does not exist in this reference (parallel = multiple independent single spawns, results steered back in completion order). I also flagged 14 fragility points (min version 0.8.2, no exit code on pane.exited, no event replay, TSTP trap, resume stale-sidecar race, etc.) and condensed the minimum viable call set.