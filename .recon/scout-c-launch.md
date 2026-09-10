Now the herdr client and common/run files:

# LAUNCH + COMPLETION CONTRACT (current HEAD)

Repo: `/Users/tinyphat/.pi/agent/extensions/subagent/` @ `e620fdc` ("feat: advertise agent descriptions in the subagent tool description"). All line numbers below are from HEAD.

## Files Retrieved

1. `src/launch.ts` (lines 1-682) — LaunchPlan builder: artifact paths, pi argv, wrapper script (spawn + resume)
2. `src/watcher.ts` (lines 1-408) — per-subagent completion watcher, classification matrix
3. `src/subagent-done.ts` (lines 1-307) — extension loaded into the CHILD via `-e`; writes `.exit` sidecar
4. `src/session.ts` (lines 1-88) — `.jsonl` parsing, `findLastAssistantMessage`
5. `src/herdr/client.ts` (lines 1-303) — herdr CLI wrapper (`paneStart`, `paneClose`, `ping`, `pluginGet`)
6. `src/herdr/events.ts` (lines 1-185) — ndJSON unix-socket event stream (`pane.exited`/`pane.closed`)
7. `src/herdr-tools/spawn.ts` (lines 1-487) — `subagent` tool execute (single + parallel)
8. `src/herdr-tools/runtime.ts` (lines 1-260) — capability check, event-stream singleton, watcher arming, deps seam
9. `src/herdr-tools/common.ts` (lines 1-50) — `writePlanFiles`, `FIRE_AND_FORGET_NOTE`, context types
10. `herdr-plugin/herdr-plugin.toml` (lines 1-21) — plugin manifest, `dispatch.sh` entrypoint
11. `herdr-plugin/dispatch.sh` (lines 1-16) — fixed dispatcher, execs the wrapper script
12. `src/messages.ts` (lines 1-405) — outcome → steer message builders
13. `src/context-usage.ts` (lines 1-83) — `.context-usage` sidecar
14. `src/run.ts` (lines 1-265) — the OLD blocking-branch subprocess runner (`--mode json -p --no-session`); NOT used by the herdr branch
15. `src/types.ts` (line 6) — `MAX_PARALLEL_TASKS = 8`
16. `index.ts` (lines 1-88) — branch selector: herdr fire-and-forget vs blocking
17. `src/agent-defs.ts` (lines 242-309) — `getDefaultSessionDirFor`, `resolveSubagentPaths`

---

## 1. WRAPPER SCRIPT — `src/launch.ts`

Escaping helpers (`src/launch.ts:185-195, 315-367`):

```typescript
/** Ported from pi-interactive-subagents cmux.ts — the only thing taken from cmux.ts. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

```typescript
/**
 * Escape one piArgv entry for the wrapper script.
 *
 * Everything is single-quote escaped — except `$(cat ...)` command
 * substitutions (see buildPiPromptArgs): those are emitted double-quoted and
 * unescaped so the shell evaluates the substitution and passes the file's
 * content as a single raw-text argument.
 */
function scriptEscapePiArg(arg: string): string {
  if (arg.startsWith("$(cat ") && arg.endsWith(")")) return `"${arg}"`;
  return shellEscape(arg);
}
```

**THE ENTIRE WRAPPER TEMPLATE** (`src/launch.ts:325-367`) — verbatim:

```typescript
function buildWrapperScript(opts: {
  env: Record<string, string | undefined>;
  headerLines: string[];
  exports: string[];
  cwd: string;
  piArgv: string[];
  sessionFile: string;
}): { content: string; holdOpenSecs: number } {
  const launchPrefix = resolveLaunchPrefix(opts.env, opts.cwd);
  const holdOpenSecs = resolveHoldOpenSecs(opts.env);
  const piCommand =
    (launchPrefix ? `${launchPrefix} ` : "") +
    opts.piArgv.map((arg) => scriptEscapePiArg(arg)).join(" ");

  const scriptLines = [
    "#!/usr/bin/env bash",
    "# Ignore SIGTSTP — argv-launched panes have no parent interactive shell",
    "# to resume from, so Ctrl+Z would leave the pane permanently stuck.",
    "trap '' TSTP",
    ...opts.headerLines,
    ...opts.exports,
    `cd ${shellEscape(opts.cwd)}`,
    piCommand,
    'code=$?',
    // Stamp the run id so the watcher can decide ownership of this sidecar
    // outright. Resume reuses the session path, so a previous run's wrapper
    // can land its sidecar after ours was cleared; without the id the watcher
    // has to infer ownership from whether the pane is still alive, which is a
    // race whenever pane teardown is slower than the sidecar write.
    `echo "$code $PI_SUBAGENT_ID" > ${shellEscape(`${opts.sessionFile}.exitcode`)}`,
    ...(holdOpenSecs > 0
      ? [
          `if [ "$code" -ne 0 ] && [ "$SECONDS" -lt ${holdOpenSecs} ]; then`,
          `  echo "subagent crashed (exit $code) — press Enter to close"`,
          "  read -r",
          "fi",
        ]
      : []),
    'exit "$code"',
    "",
  ];
  return { content: scriptLines.join("\n"), holdOpenSecs };
}
```

So the rendered script is:

```bash
#!/usr/bin/env bash
# Ignore SIGTSTP — argv-launched panes have no parent interactive shell
# to resume from, so Ctrl+Z would leave the pane permanently stuck.
trap '' TSTP
# Subagent launch script for <name>
# Generated: <ISO>
# Session: <sessionFile>
export PATH='<parent PATH>'
export PI_CODING_AGENT_DIR='<localAgentDir or parent value>'   # conditional
export PI_DENY_TOOLS='<comma list>'                            # conditional
export PI_SUBAGENT_NAME='<name>'
export PI_SUBAGENT_AGENT='<agent>'                             # conditional
export PI_SUBAGENT_AUTO_EXIT=1                                 # conditional
export PI_SUBAGENT_SESSION='<sessionFile>'
export PI_SUBAGENT_ID='<id>'
export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"
cd '<targetCwd>'
[<direnv exec '<cwd>' | PI_HERDR_LAUNCH_PREFIX | empty> ] '<piBin>' --session '<sessionFile>' -e '<subagent-done.ts>' --model '<m>' --thinking '<t>' --tools '<a,b>' [--system-prompt|"--append-system-prompt"] "$(cat '<syspromptFile>')" [""] [/skill:a /skill:b] '@<taskFile>'
code=$?
echo "$code $PI_SUBAGENT_ID" > '<sessionFile>.exitcode'
if [ "$code" -ne 0 ] && [ "$SECONDS" -lt 15 ]; then
  echo "subagent crashed (exit $code) — press Enter to close"
  read -r
fi
exit "$code"
```

**Env var names + sources** (`src/launch.ts:485-506` for spawn; `633-644` for resume):

```typescript
  const exports: string[] = [];
  if (env.PATH) exports.push(`export PATH=${shellEscape(env.PATH)}`);
  if (localAgentDir && existsSync(localAgentDir)) {
    exports.push(`export PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (env.PI_CODING_AGENT_DIR) {
    exports.push(`export PI_CODING_AGENT_DIR=${shellEscape(env.PI_CODING_AGENT_DIR)}`);
  }
  const denySet = resolveDenyTools(agentDefs);
  if (denySet.size > 0) {
    exports.push(`export PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  exports.push(`export PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    exports.push(`export PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (autoExit) {
    exports.push("export PI_SUBAGENT_AUTO_EXIT=1");
  }
  exports.push(`export PI_SUBAGENT_SESSION=${shellEscape(sessionFile)}`);
  exports.push(`export PI_SUBAGENT_ID=${shellEscape(id)}`);
  // The pane id is only known inside the pane — forward herdr's injected env.
  exports.push('export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"');
```

**direnv/launch prefix** (`src/launch.ts:291-312`):

```typescript
function resolveLaunchPrefix(env: Record<string, string | undefined>, cwd: string): string {
  const template = env.PI_HERDR_LAUNCH_PREFIX;
  if (template != null) {
    return template.replaceAll("{cwd}", shellEscape(cwd)).trim();
  }
  if (env.PI_HERDR_DIRENV === "0") return "";
  if (hasEnvrc(cwd)) return `direnv exec ${shellEscape(cwd)}`;
  return "";
}

function resolveHoldOpenSecs(env: Record<string, string | undefined>): number {
  const raw = env.PI_HERDR_HOLD_OPEN_SECS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HOLD_OPEN_SECS; // 15
}
```

**pi argv order** (`src/launch.ts:433-479`):

```typescript
  const piBin = env.PI_HERDR_PI_BIN ?? (ctx.resolvePiBin ?? defaultResolvePiBin)(env);
  const piArgv: string[] = [piBin, "--session", sessionFile];

  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "src", "subagent-done.ts");
  piArgv.push("-e", subagentDonePath);

  // Phase 0: model and thinking are two independent flags in this runtime —
  // the `model:thinking` colon syntax is not used.
  if (effectiveModel) {
    piArgv.push("--model", effectiveModel);
  }
  if (effectiveThinking) {
    piArgv.push("--thinking", effectiveThinking);
  }
  // ... syspromptFile written first (below) ...
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, ctx.availableTools);
  if (toolAllowlist) {
    piArgv.push("--tools", toolAllowlist);
  }
  // ... taskArtifactFile written (below), taskArg = `@${taskArtifactFile}` ...
  piArgv.push(
    ...buildPiPromptArgs({
      effectiveSkills,
      taskArg,
      systemPrompt:
        syspromptFile && systemPromptMode
          ? { file: syspromptFile, mode: systemPromptMode }
          : undefined,
    }),
  );
```

Exact argv order: `pi --session <file> -e <subagent-done.ts> --model <m> --thinking <t> --tools <list> [--system-prompt|--append-system-prompt] "$(cat <syspromptFile>)" ["" /skill:a /skill:b...] @<taskFile>`

**`--system-prompt` vs `--append-system-prompt` — the comment** (`src/launch.ts:43-45` + `183-195` + `212-235`):

```
// - `--system-prompt <text>` — RAW TEXT ONLY, no file auto-detection: verified.
// - `--append-system-prompt <text>` — accepts text or file contents (auto-reads
//   a file path argument): verified.
```

```typescript
/**
 * File-content argument for a system-prompt flag: a command substitution over
 * a shell-escaped path. The substitution is emitted double-quoted by
 * scriptEscapePiArg, so bash evaluates it and pi receives the file's content
 * as one raw-text argument — file-based without shell-escaping the content.
 */
function fileContentArg(path: string): string {
  return `$(cat ${shellEscape(path)})`;
}
```

Mode chosen by `systemPromptMode` from the agent def: `"replace"` → `--system-prompt`, `"append"` → `--append-system-prompt`; both get the same `$(cat <file>)` arg.

**Script path, mode, naming** (`src/launch.ts:522`):

```typescript
  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name}-${id}.sh`);
```

- `<artifactDir>/subagent-scripts/<safeName>-<runId>.sh` (resume: `<safeName>-resume-<runId>.sh`, `launch.ts:660`)
- Written by `writePlanFiles` in `src/herdr-tools/common.ts:16-20` with plain `writeFileSync(file.path, file.content, "utf8")` — **NO chmod, mode 0644 default**; it is executed via `exec bash "$launch_script"` (bash invoked explicitly), so no exec bit is needed.
- `safeName` (`launch.ts:242-250`): lowercase, `[^a-z0-9\s-]` stripped, spaces→`-`, collapse `-`, fallback `"subagent"`.
- Run id (`launch.ts:374-377`): `Math.random().toString(16).slice(2, 10)`.

**Task file content** (`src/launch.ts:466-471`):

```typescript
  // ── Task message (artifact-delivered with wrapper instructions) ──
  const modeHint = autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = Boolean(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
```

## 2. ARTIFACT PATHS

Base dir: `getArtifactDir(sessionDir, sessionId)` = `<orchestrator sessionDir>/artifacts/<orchestrator sessionId>/` (`launch.ts:237-239`). Child session dir: `getDefaultSessionDirFor(cwd, agentDir)` = `<agentDir>/sessions/--<cwd with /,\\,: → ->>--/` (`agent-defs.ts:260-272`, mkdir'd during planning).

| purpose | exact path / suffix | who writes | who reads |
|---|---|---|---|
| wrapper script | `<artifactDir>/subagent-scripts/<name>-<id>.sh` (resume: `<name>-resume-<id>.sh`) | orchestrator (`writePlanFiles`) | herdr plugin dispatcher (`exec bash`) |
| task file | `<artifactDir>/context/<name>-<YYYY-MM-DDTHH-MM-SS>.md` | orchestrator | child pi (as `@<taskFile>` positional) |
| system-prompt file | `<artifactDir>/context/<name>-sysprompt-<YYYY-MM-DDTHH-MM-SS>.md` | orchestrator | wrapper shell `$(cat ...)` |
| resume message file | `<artifactDir>/subagent-resume/<name>-<YYYY-MM-DDTHH-MM-SS>.md` | orchestrator | child pi (`@<file>`) |
| child session | `<childSessionDir>/<ts>_<id>-<rand>-<rand>-<rand>.jsonl`, ts = `now.toISOString().replace(/[:.]/g,"-").slice(0,23)+"Z"` (`launch.ts:404-414`) | child pi | watcher (summary), resume |
| **completion sidecar** | `<sessionFile>.exit` — `{"type":"done"}` or `{"type":"ping","name","message"}` | child (subagent-done.ts) | watcher (classifies, then deletes) |
| **exit-code sidecar** | `<sessionFile>.exitcode` — `"<code> <runId>\n"` | wrapper script | watcher (authoritative exit code; then deletes) |
| context-usage sidecar | `<sessionFile>.context-usage` — `{"version":1,"subagentId","tokens","contextWindow","percent"}` | child (subagent-done.ts) | orchestrator (`consumeContextUsageSidecar`), then deleted |

Timestamp format for artifacts (`launch.ts:423`): `now.toISOString().replace(/[:.]/g, "-").slice(0, 19)`.

## 3. SUBAGENT-DONE HOOK — `src/subagent-done.ts`

Sidecar writer (`subagent-done.ts:81-86`):

```typescript
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  const payload =
    data.type === "done"
      ? { type: "done" as const }
      : { type: "ping" as const, name: data.name, message: data.message };
  writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
}
```

Terminal-signal gate (`subagent-done.ts:156-161`):

```typescript
  function signalTerminalSidecar(data: ExitSidecarData): void {
    if (terminalSidecarWritten) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    writeExitSidecar(sessionFile, data);
    terminalSidecarWritten = true;
  }
```

Lifecycle hooks — **`agent_end`** is the auto-exit path (`subagent-done.ts:211-233`):

```typescript
  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit =
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages, getActiveSubagentCount());

    if (shouldExit) {
      // Write the .exit sidecar so the watcher classifies this as a proper
      // completion, not a user close. Most models finish and stop talking
      // without explicitly calling subagent_done — a clean auto-exit IS a
      // completion.
      snapshotContextUsage(ctx);
      signalTerminalSidecar({ type: "done" });
      ctx.shutdown();
      return;
    }
```

**`subagent_done` tool** (`subagent-done.ts:286-307`) — writes at TOOL-CALL time:

```typescript
  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        snapshotContextUsage(ctx);
        signalTerminalSidecar({ type: "done" });
      }
      ctx.shutdown();
      ...
```

**`caller_ping` tool** (`subagent-done.ts:255-283`) — writes ping sidecar, then `ctx.shutdown()`.

`session_shutdown` (`subagent-done.ts:237-240`) writes only the **context-usage** snapshot (fallback, no overwrite); it does **NOT** write `.exit` — user-driven exits produce no `.exit`, which is how the watcher gets `completed-user-exit`.

**No, the final assistant text is NOT in the sidecar.** `.exit` is only a signal (`{"type":"done"}`); the summary itself is read later from the session `.jsonl` by the watcher.

## 4. HERDR PANE OPEN

Client call (`src/herdr/client.ts:180-213`) — it is a **CLI invocation**, not a raw socket (socket is only for events):

```typescript
    async paneStart(p) {
      const args = [
        "plugin",
        "pane",
        "open",
        "--plugin",
        HERDR_PLUGIN_ID,            // "pi-herdr-subagents"
        "--entrypoint",
        HERDR_PLUGIN_ENTRYPOINT,    // "subagent"
        "--placement",
        "split",
      ];
      if (p.targetPaneId) args.push("--target-pane", p.targetPaneId);
      args.push("--direction", p.direction ?? "right");
      args.push("--cwd", p.cwd);
      for (const [key, value] of Object.entries({
        ...p.env,
        PI_HERDR_LAUNCH_SCRIPT: p.launchScriptFile,
      })) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--no-focus");

      const result = await execHerdrJson<{
        plugin_pane?: { pane?: Record<string, unknown> };
      }>(args);
```

Exact argv: `herdr plugin pane open --plugin pi-herdr-subagents --entrypoint subagent --placement split --target-pane <HERDR_PANE_ID> --direction right --cwd <targetCwd> --env PI_HERDR_LAUNCH_SCRIPT=<wrapper path> --no-focus`. Response JSON: `result.plugin_pane.pane.pane_id`. Constants (`client.ts:48-51`): `HERDR_PLUGIN_ID = "pi-herdr-subagents"`, `HERDR_PLUGIN_ENTRYPOINT = "subagent"`, `HERDR_PLUGIN_ARGV_ENTRYPOINT = "argv"`.

After start (`src/herdr-tools/spawn.ts:75-77`): `await getDeps().client.paneRename(started.paneId, request.name ?? "Subagent").catch(() => {});`

**`herdr-plugin/herdr-plugin.toml` (lines 1-21) — verbatim:**

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

**`herdr-plugin/dispatch.sh` (lines 1-16) — verbatim:**

```bash
#!/usr/bin/env bash
set -u

launch_script="${PI_HERDR_LAUNCH_SCRIPT:-${PI_SUBAGENT_LAUNCH_SCRIPT:-}}"

if [[ -z "$launch_script" ]]; then
  echo "pi-herdr-subagents dispatcher: PI_HERDR_LAUNCH_SCRIPT is unset or empty; legacy fallback PI_SUBAGENT_LAUNCH_SCRIPT is also unset or empty" >&2
  exit 64
fi

if [[ ! -r "$launch_script" ]]; then
  echo "pi-herdr-subagents dispatcher: launch script is not readable (PI_HERDR_LAUNCH_SCRIPT or legacy fallback PI_SUBAGENT_LAUNCH_SCRIPT): $launch_script" >&2
  exit 66
fi

exec bash "$launch_script"
```

Resolution chain: CLI `--entrypoint subagent` selects the toml pane with `id = "subagent"`, whose `command` is exec'd by the plugin dispatcher; `$HERDR_PLUGIN_ROOT` (protected env injected by herdr) points at the linked plugin dir, so it resolves to `dispatch.sh`; the launch script path reaches the pane as env var `PI_HERDR_LAUNCH_SCRIPT` (passed via `--env` on the CLI); dispatch.sh `exec bash`s it. `--cwd` is the pane cwd, but the wrapper re-`cd`s anyway ("--cwd overrides the pane's working directory").

## 5. WATCHER LIFECYCLE — `src/watcher.ts`

Outcome states = the exact lifecycle classification (`watcher.ts:31-40`):

```typescript
export type SubagentOutcome =
  | { kind: "completed"; summary: string; exitCode: 0 }
  | { kind: "completed-user-exit"; summary: string; exitCode: 0 } // no .exit sidecar
  | { kind: "ping"; name: string; message: string }
  | { kind: "launch-failed"; exitCode: number; heldOpen: boolean; paneOutput: string | null }
  | { kind: "crashed"; exitCode: number; summary: string | null; paneOutput: string | null }
  | { kind: "pane-killed"; summary: string | null }
  | { kind: "gap-exit"; summary: string | null; exitCode: number | null }
  | { kind: "cancelled" };
```

Detection = 3 signal sources, triggers `"event" | "sidecar" | "gone"` (`watcher.ts:58, 396`):

- **(a)** `deps.stream.watch(paneId, ...)` — socket events `pane_exited`/`pane_closed` (no replay; reconnect fires `onReconcile`).
- **(b)** `fs.watch(dirname(sessionFile))` on filenames `.exit`/`.exitcode` **plus a 5s `setInterval` poll** (`DEFAULT_POLL_INTERVAL_MS = 5_000`, `watcher.ts:65`).
- **(c)** reconcile → `paneList()` membership check; poll → `paneGet() === null` ("gone").

Authoritative exit code = **`<sessionFile>.exitcode`**, written by the wrapper as `"<code> <runId>"` (`watcher.ts:187-197`):

```typescript
    function readExitCode(): { code: number; id: string | null } | null {
      try {
        const raw = readFileSync(exitcodeFile, "utf8").trim();
        const [codeText, idText] = raw.split(/\s+/, 2);
        const parsed = Number.parseInt(codeText, 10);
        return Number.isFinite(parsed) ? { code: parsed, id: idText || null } : null;
      } catch {
        return null;
      }
    }
```

Classification matrix (`watcher.ts:216-262`):

```typescript
    function classify(trigger: Trigger): SubagentOutcome | null {
      const exitData = readExitSidecar();
      if (exitData?.type === "ping") {
        return {
          kind: "ping",
          name: exitData.name ?? running.name,
          message: exitData.message ?? "",
        };
      }
      if (exitData?.type === "done") {
        return {
          kind: "completed",
          summary: readSummary() ?? "Sub-agent exited without output",
          exitCode: 0,
        };
      }

      const exitInfo = readExitCode();
      if (exitInfo !== null) {
        // A sidecar stamped with a different run's id is definitively not ours
        // (resume reuses the session path). Consume it and keep watching.
        if (exitInfo.id !== null && exitInfo.id !== running.id) {
          try {
            rmSync(exitcodeFile, { force: true });
          } catch {}
          return null;
        }
        exitcodeIdMatched = exitInfo.id !== null;
        const exitCode = exitInfo.code;
        if (exitCode === 0) {
          // No .exit sidecar → the user drove the session and quit pi normally.
          return {
            kind: "completed-user-exit",
            summary: readSummary() ?? "Sub-agent exited without output",
            exitCode: 0,
          };
        }
        const withinStartupWindow = now() - running.startTime < startupWindowMs;
        if (withinStartupWindow && readSessionEntries().length === 0) {
          // Startup crash (e.g. bad --model). If the wrapper's hold-open kept
          // the pane alive, no pane event has fired — the sidecar is the signal.
          return {
            kind: "launch-failed",
            exitCode,
            heldOpen: !paneEventSeen,
            paneOutput: null,
          };
        }
        return { kind: "crashed", exitCode, summary: readSummary(), paneOutput: null };
      }

      // No sidecars at all.
      if (trigger === "event") {
        return { kind: "pane-killed", summary: readSummary() };
      }
      if (trigger === "gone") {
        return { kind: "gap-exit", summary: readSummary(), exitCode: null };
      }
      return null; // sidecar trigger without sidecars — not a signal
    }
```

Two liveness guards in `trySettle` (`watcher.ts:264-332`):
- `completed`: `.exit` is written at tool-call time; a `done` sidecar while the pane still exists is "completion-IMMINENT" — it polls `paneGet` and only finishes when the pane is `null`.
- `completed-user-exit` via unstamped sidecar trigger: if pane still alive, consume `.exitcode` and keep watching (stale resume race).

Success = `.exit` `{"type":"done"}` **and** pane gone → `completed`, exitCode **0**; or exitcode sidecar `0` without `.exit` → `completed-user-exit`. Both watcher-finishes `consumeSidecars=true` → `rmSync` both sidecars.

## 6. FINAL TEXT READBACK

`watcher.ts:142-152`:

```typescript
    function readSessionEntries() {
      try {
        return getNewEntries(running.sessionFile, 0);
      } catch {
        return [];
      }
    }

    function readSummary(): string | null {
      return findLastAssistantMessage(readSessionEntries());
    }
```

`src/session.ts:29-34` (entry shape: version-3 `.jsonl`, crash-safe incremental writes) and `session.ts:73-88`:

```typescript
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }
  return null;
}
```

- File read: the **child session `.jsonl`** — `running.sessionFile` in the orchestrator, env **`PI_SUBAGENT_SESSION`** in the child (also `PI_SUBAGENT_NAME`, `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_PANE`, `PI_SUBAGENT_AUTO_EXIT`, `PI_DENY_TOOLS`, `PI_CODING_AGENT_DIR`).
- Truncation: **none** in extraction — all non-empty text blocks of the last assistant message joined with `"\n"`. (Display renderers in `messages.ts` slice to terminal width, but the steer `details.summary` is untruncated.)
- Missing file: `readSessionEntries` catches → `[]` → `readSummary()` null → fallback strings `"Sub-agent exited without output"` (completed/completed-user-exit) or `"No assistant output captured."` (pane-killed/gap-exit).

## 7. PANE CLOSE

**There is NO orchestrator-side pane close in this copy.** `client.paneClose(paneId)` exists (`client.ts:267-269`: `await execHerdrJson(["pane", "close", paneId]);`) but its only callers are tests. The pane closes itself when the wrapper script's `exit "$code"` terminates it (herdr reaps the exited plugin pane; hold-open on crash deliberately keeps it). No retry/backoff for close. Cleanup order:

- Watcher `finish()` (`watcher.ts:103-127`): run all `cleanups` in push order — unwatch event listener, `fsWatcher.close()`, `clearInterval(pollTimer)`, `offReconcile`, remove abort listener — then consume sidecars (`rmSync .exit`, `rmSync .exitcode`), then resolve. On **abort/cancel** the sidecars are NOT consumed (`consumeSidecars=false`).
- Module teardown `closeStreamAndAbort()` (`runtime.ts:63-69`): **stream close first, then abort** — `if (eventStream) eventStream.close(); eventStream = null; currentAbort.abort();` — invoked from `rearm()` (`/reload`) and `session_shutdown` in registration.

## 8. SPAWN TOOL EXECUTE — `src/herdr-tools/spawn.ts`

`executeSubagentSpawn` order (`spawn.ts:284-380`):
1. agent discovery (`discoverAgents(ctx.cwd, agentScope)`, scope default `"both"`)
2. `validateMode` — exactly one of single (`agent`+`task`) / parallel (`tasks`)
3. profile validation (`loadProfilesIfEnabled`, `validateProfiles` — profile is **compulsory**)
4. `collectRequests` — enforces per-request profile
5. confirmProjectAgents gate (computed, intentionally disabled)
6. self-spawn block (`process.env.PI_SUBAGENT_AGENT` match → error)
7. `ensureHerdrCapability()` — **must stop before artifacts/panes are created**
8. `launchRequests` per request: agent lookup → `resolveProfile(lookupProfile(profile, profiles, parentDefaults), agentConfig, parentDefaults)` → name dedup → `loadAgentDefFor` → `spawnOneSubagent`
9. immediate ack:

```typescript
	const lines = [
		...spawned.map((s) => `spawned ${s.name} (pane ${s.paneId})${s.profile ? ` [${s.profile}]` : ""}`),
		...failed.map((f) => `failed ${f.agent}: ${f.error}`),
		...spawned.flatMap((s) => s.toolWarnings ?? []),
	];
	return {
		content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${FIRE_AND_FORGET_NOTE}` }],
		details: {
			status: "started",
			agentScope,
			spawned,
			failed,
		},
	};
```

`spawnOneSubagent` body order (`spawn.ts:80-136`): plan build (`buildLaunchPlan`, model order: explicit param > profile > agent def > parent model) → `writePlanFiles(plan.files)` → `getDeps().client.paneStart(plan.paneStart)` → `paneRename` → build `RunningSubagent` → `armWatcher(pi, running, { sessionId: ctx.sessionManager.getSessionId() })` → return ack `{id, name, agent, profile, paneId, sessionFile, launchScriptFile, toolWarnings?}`. Every failure path happens before artifacts/panes are created.

**`tasks[]` parallel EXISTS in this copy**: `collectRequests` (`spawn.ts:170-207`) maps each `tasks[]` item (each requiring its own `profile`) into a `HerdrSpawnRequest`, with explicit `model/tools/systemPrompt/interactive` overrides applied to every child; cap `MAX_PARALLEL_TASKS = 8` (`types.ts:6`). Launch is **sequential** in `launchRequests` (`spawn.ts:213-259`), each child gets its own independent `armWatcher` — there is **no waiting/combining**: results arrive as independent steer messages. Single-mode params may not be mixed with `tasks` (`validateMode`, `modeCount !== 1`).

## 9. RUNTIME CAPABILITY — `src/herdr-tools/runtime.ts`

Version check + capability (`runtime.ts:107-172`):

```typescript
export function versionAtLeast(actual: string, minimum: string): boolean {
	const parse = (value: string): number[] | null => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		return match ? match.slice(1).map(Number) : null;
	};
	const actualParts = parse(actual);
	const minimumParts = parse(minimum);
	if (!actualParts || !minimumParts) return false;
	for (let i = 0; i < 3; i += 1) {
		if (actualParts[i] !== minimumParts[i]) return actualParts[i] > minimumParts[i];
	}
	return true;
}
```

```typescript
async function checkHerdrCapability(): Promise<string | null> {
	const status = await deps.client.ping();
	if (!status.ok) {
		return (
			"the herdr server is not reachable from this pane. " +
			"Is the herdr session still running?"
		);
	}
	if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
		return (
			`herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes ` +
			`(found ${status.version ?? "unknown"}). Update herdr, then restart its session.`
		);
	}

	const plugin = await deps.client.pluginGet(HERDR_PLUGIN_ID);
	if (!plugin) {
		const pluginDir = path.join(path.dirname(modulePath ?? ""), "herdr-plugin");
		return (
			`the Herdr plugin is not linked. Run: herdr plugin link "${pluginDir}" --enabled`
		);
	}
	if (!plugin.enabled) {
		return `the Herdr plugin is disabled. Run: herdr plugin enable ${HERDR_PLUGIN_ID}`;
	}
	return null;
}

export async function ensureHerdrCapability(): Promise<string | null> {
	const check = (capabilityCheck ??= checkHerdrCapability());
	try {
		const message = await check;
		// Allow an in-place setup fix (link/enable/update) to be detected by the
		// next attempt without requiring a pi reload. Successful checks stay cached.
		if (message && capabilityCheck === check) capabilityCheck = null;
		return message;
	} catch (error) {
		if (capabilityCheck === check) capabilityCheck = null;
		throw error;
	}
}

/** Drop any cached capability result (session_start re-checks readiness). */
export function invalidateCapability(): void {
	capabilityCheck = null;
}
```

Note: `MIN_HERDR_VERSION = "0.7.0"` in `client.ts:52` (with plugin link/enabled checks), while `herdr-plugin.toml` declares `min_herdr_version = "0.8.2"` (enforced by herdr itself). Ping is `herdr status server --json` → `{ok: status.running === true, version, protocol}`.

Event-stream singleton (`runtime.ts:120-127`): lazy `getEventStream()` → `deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal())`, one per process, closed on abort. Reconnect backoff `[500, 1000, 2000, 5000]` ms (`events.ts:41`); subscribe frame (`events.ts:104-110`): `{"id":"sub<N>","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"}]}}`.

RuntimeDeps seam (`runtime.ts:22-40`):

```typescript
export type WatcherStream = WatcherDeps["stream"] & { close(): void };

export interface RuntimeDeps {
	client: HerdrClient;
	watch: typeof watchSubagent;
	createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

export function defaultDeps(): RuntimeDeps {
	return {
		client: createHerdrClient(),
		watch: watchSubagent,
		createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
	};
}
```

`armWatcher` (`runtime.ts:176-225`): sets `running.abortController`, chains module abort signal, registers in `runningSubagents` map + `markSubagentActive`, then `deps.watch(running, {client, stream: getEventStream(), signal})` → on outcome: delete from map, `consumeContextUsageSidecar(sessionFile, id)`, `buildOutcomeMessage(...)` → `pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" })`. `customType` strings `"subagent_result"` / `"subagent_ping"` are load-bearing (`messages.ts:6-8`).

## MINIMAL SEQUENCE

A from-scratch spawn-only reimplementation must reproduce, in order:

1. **Activate**: orchestrator pi runs inside herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH` all set) AND `settings.json` has `"subagent": {"herdr": true}` (`src/herdr-tools/guard.ts:16-21, 24-36`).
2. **Capability**: `herdr status server --json` (running, version ≥ 0.7.0) + `herdr plugin list --plugin pi-herdr-subagents --json` (linked + enabled). Cache; null on failure.
3. **Plan**: id = 8-hex random; artifact dir `<orchestrator sessionDir>/artifacts/<sessionId>/`; child session dir `<agentDir>/sessions/--<munged cwd>--/` (mkdir); child session file `<ts>_<uuid>.jsonl` where ts = `toISOString().replace(/[:.]/g,"-").slice(0,23)+"Z"`.
4. **Write files** (mkdir -p each dirname, plain writeFileSync, mode 0644): sysprompt md (optional), task md with content `<role>\n\n<modeHint>\n\n<task>\n\n<summaryInstruction>`, wrapper script `<artifactDir>/subagent-scripts/<name>-<id>.sh`.
5. **pi argv**: `<abs pi> --session <sessionFile> -e <subagent-done.ts> --model <m> --thinking <t> --tools <expanded allowlist + caller_ping,subagent_done> [--system-prompt "$(cat '<sysprompt>')] [""] /skill:*... @<taskFile>`.
6. **Wrapper**: bash script with `trap '' TSTP`, curated exports (PATH, PI_CODING_AGENT_DIR, PI_DENY_TOOLS, PI_SUBAGENT_NAME/AGENT/AUTO_EXIT/SESSION/ID, `PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"`), `cd <cwd>`, optional `direnv exec '<cwd>'` prefix, pi command, `code=$?`, `echo "$code $PI_SUBAGENT_ID" > <sessionFile>.exitcode`, crash hold-open (`$SECONDS < 15`), `exit "$code"`.
7. **Open pane**: `herdr plugin pane open --plugin pi-herdr-subagents --entrypoint subagent --placement split --target-pane <HERDR_PANE_ID> --direction right --cwd <cwd> --env PI_HERDR_LAUNCH_SCRIPT=<wrapper> --no-focus`; then `herdr pane rename <paneId> <name>` (best-effort). Plugin dispatcher: `command = ["bash","-c","exec bash \"$HERDR_PLUGIN_ROOT/dispatch.sh\""]`, dispatch.sh reads `PI_HERDR_LAUNCH_SCRIPT` and `exec bash`es the wrapper. Ack string: `spawned <name> (pane <id>) [<profile>]` + FIRE_AND_FORGET_NOTE; `details.status = "started"`.
8. **Arm watcher**: subscribe once over unix socket `$HERDR_SOCKET_PATH` to `pane.exited` + `pane.closed`; `fs.watch` session dir for `.exit`/`.exitcode`; 5s poll; reconcile hook → pane-list check. Classify per matrix (§5). Consume (rm) both sidecars on resolution. Completion requires `done` sidecar + pane gone. Success = exitCode 0.
9. **Readback**: summary = last non-empty assistant text block(s) in child `.jsonl` (walk entries backwards; join text blocks with `"\n"`; missing file → fallback string).
10. **Deliver**: `pi.sendMessage({customType: "subagent_result"|"subagent_ping", content, display: true, details}, {triggerTurn: true, deliverAs: "steer"})` with details `{name, task, agent, elapsed, sessionFile, sessionId, paneId, disposition, contextUsage?, exitCode?, summary?}`.
11. **No pane close** — the pane self-closes via wrapper exit; cleanup is unwatch → fsWatcher close → clearInterval → reconcile off → abort-listener off → rm sidecars. Optional context-usage sidecar `<sessionFile>.context-usage` written by child, consumed+deleted by orchestrator.

`src/run.ts` is the legacy blocking branch (`pi --mode json -p --no-session` subprocess, JSON event parsing, SIGTERM/SIGKILL abort) — irrelevant to the herdr spawn contract.

The extraction is complete and delivered as `subagent_done` output above: the full launch + completion contract at HEAD `e620fdc`, with verbatim code and file:line headers for all 9 requested areas — wrapper script template, artifact path table, subagent-done sidecar hooks, herdr pane-open argv + dispatch.sh + plugin toml, watcher classification matrix, session `.jsonl` readback, pane-close/cleanup order (no orchestrator pane close exists), the single + `tasks[]` spawn execute path, and runtime capability/version/event-stream/deps seam — ending with the ordered MINIMAL SEQUENCE for a from-scratch spawn-only reimplementation.