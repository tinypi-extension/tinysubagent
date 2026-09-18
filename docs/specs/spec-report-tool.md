# Spec: subagent result report tool

Status: **superseded in part** by `docs/spec-report-required.md`, which removes the
settle fallback and makes a reported turn the only automatic close. Extends
`docs/intent.md`; that document is the contract and this one must not contradict it
without editing the conflicting line first.

## Assumptions I'm making

1. The result payload is carried **in the sidecar**, not in the child's session — the
   parent stops reading the session for the normal path.
2. The parent-side delivery is **unchanged**: one steer message per batch, still
   `triggerTurn: true`, now sourced from the report payload when one exists.
3. "Close the pane automatically" is already satisfied by `ctx.shutdown()` — pi exits,
   the wrapper stamps `<sessionFile>.exitcode`, the pane's command returns, herdr reaps
   the pane. The report tool needs no new herdr call.
4. The role's `tools` frontmatter stays authoritative for everything **except** the one
   report tool, which is injected. `docs/intent.md:24` is edited to say so.
5. The reminder is load-bearing, not decoration: it goes in the task markdown *and* the
   tool description, because a model that never discovers the tool never reports.

→ Correct these now or I proceed with them.

## Objective

Today a subagent's result reaches the orchestrator by two indirect steps: the child
writes a **content-free** sidecar when its turn settles, and the parent then scrapes the
child's session jsonl for the text. The result is therefore *inferred*, and it only
exists once the turn has drained.

Replace that with an explicit hand-back: the child calls `subagent_report` with its
result as an argument, and that text is what the parent delivers — mid-turn, without
waiting for a settle.

Secondary defect this fixes: the child-side tool that exists today, `tinysubagent_done`
(`src/children/child.ts`), is **unreachable**. `spawnOne` passes only the role's expanded
frontmatter list as `tools` (`src/children/spawn.ts:97`), which becomes the child's `--tools`
allowlist (`src/children/launch-script.ts:125`) — documented as covering "built-in, extension, and custom
tools" (README.md:583) — so no role can call it unless its frontmatter happens to name it.
It is also content-free, so even when callable it would only move the settle signal
earlier.

**User:** whoever is orchestrating — the human, or any model driving tinysubagent.

**Success:** a child that decides at any point in its turn that it is done can hand back
its complete result immediately; the pane goes away on its own; the parent sees that text
within the watcher's existing 1s poll, labelled as reported.

## Scope check

One capability. No capability map.

## The data contract

One sidecar, extended additively. `<sessionFile>.done`:

```jsonc
{"type":"done","result":"<the child's result text>"}   // new: explicit report
{"type":"done"}                                        // legacy: settled, no payload
{"type":"failed","reason":"error"|"aborted"|"exit"|"no-output"}
{"type":"failed","reason":"error","message":"<why>"}  // new: refused before any run
```

`result` is optional. Absent ⇒ the parent falls back to today's session scrape. No
version field: an old reader ignores `result` and still works, and a new reader tolerates
its absence.

`message` is optional too, and is written only on a failure that left **no turn** in the
session to explain itself: pi refuses to start a run when no model is selected or the
provider has no usable credentials, and it throws out of `prompt()` before the agent phase.
No run means no settle hook, so the refusal is reported from the child's `input` hook
instead (`docs/spec-child-preflight-failure.md`), and the message is the orchestrator's only
account of it. Where a turn does exist, the session still speaks for the failure, and the
order is `report message ?: last assistant text ?: session failure note`: a message is
written only for the run that produced no turn, so it is always fresher than the scrape.

`aborted` is a reason the reader tolerates, but one the child no longer writes. The
interrupt rule lives in the child: a run whose own abort signal was set — or whose stop
reason pi labelled `aborted` — writes *nothing at all*, because the child is alive at its
prompt and has not finished. The signal is checked because the stop reason is not enough:
pi files the common case, an Esc that lands during a tool call, as a plain `error`
("This operation was aborted"), which no stop reason can tell apart from a real failure.
The watcher additionally drops an `aborted` report and keeps watching the same pane, so an
interrupt cannot end a batch from either side. The batch ends on the child's next report, or
when the pane goes away. A child that is interrupted and then never reports again holds its
batch open until its pane closes — deliberately, because the alternative is telling the
orchestrator a job closed while the user is still steering it.

### Classification (authoritative)

| Report | Exit code | Outcome | `summary` |
|---|---|---|---|
| `result` present, non-empty | any | `{kind:"completed", via:"report"}` | `result` |
| `done`, no `result` | any | `{kind:"completed", via:"turn-end"}` | session scrape |

> Legacy row. Children no longer write a content-free `done` (`spec-report-required.md`):
> a settled turn without a report is not an ending. The watcher still tolerates the
> payload, and `via:"turn-end"` remains reachable through a manual quit.
| absent | `0` | `{kind:"completed", via:"session-exit"}` | session scrape |
| absent | non-zero | `{kind:"failed", reason:"exit"}` | scrape ?: failure note |
| `failed`, reason ≠ `aborted` | any | `{kind:"failed", reason}` | report `message` ?: scrape ?: failure note |
| `failed`, reason = `aborted` | any | *not terminal* — report dropped, wait continues | — |
| *no report*, no exit code, pane alive | — | *not terminal* — the wait continues | — |
| absent, no exit code, pane gone | — | `{kind:"cancelled"}` | scrape |

Precedence is unchanged: report file, then exit code, then pane liveness.

### Atomic write

`writeReportFile` writes `<file>.tmp` and `renameSync`s it into place. This is a
requirement introduced by this change: the sidecar goes from ~20 bytes to a full result
document, and a torn read of a large payload would either lose the result or, worse, be
classified by the existing "malformed ⇒ settled" rule as a completion with the wrong text.

The "malformed ⇒ settled" rule itself (`src/children/watcher.ts:90`) **stays**. It is the
anti-hang backstop and it is tested. Atomic rename is what makes it not matter.

## The tool

`subagent_report`, registered by the child extension alongside the existing hooks.

```ts
parameters: Type.Object({
  result: Type.String({
    description:
      "Your complete result — the full text the caller receives, not a pointer to it.",
  }),
})
```

Behavior:

1. Serialize `{type:"done", result}` and atomically write it to `$PI_TINYSUBAGENT_REPORT`.
2. On a successful write, call `ctx.shutdown()` — this is the "close the pane
   automatically" step, and it is already the exit path the child uses. `ctx.shutdown()`
   is documented as "Available in all contexts (event handlers, tools, commands,
   shortcuts)" and *requests* a graceful shutdown rather than killing pi mid-`execute`,
   so the tool result still lands and the sidecar is already on disk either way.
3. On a failed write, stay alive and return the failure, so the child can retry or finish
   normally and fall back to the settle path.
4. A second call is a no-op.

`tinysubagent_done` is removed. It is unreachable today, and pi ignores unknown names in
`--tools` rather than failing (`setActiveToolsByName`: "Unknown tool names are ignored"),
so a role that names it in frontmatter loses nothing but a warning.

## The allowlist injection

`spawnOne` force-adds the report tool to the child's `--tools` list, after the nesting
guard runs:

```ts
if (tools !== null && !tools.includes(REPORT_TOOL_NAME)) tools.push(REPORT_TOOL_NAME);
```

The `tools !== null` guard matters: a role with no `tools` frontmatter passes no `--tools`
flag at all, so every tool including the report tool is already active — injecting would
create an allowlist where none existed and silently narrow the child.

`REPORT_TOOL_NAME` lives in `src/types.ts`, not `src/children/child.ts`. `src/children/spawn.ts` documents
itself as "deliberately free of any pi extension API" and `child.ts` imports that API;
`types.ts` is the dependency-free home both can share.

## The reminder

Two placements, because a single reminder is what the forgetfulness proves insufficient:

**1. `buildTaskMarkdown` (`src/children/task-markdown.ts:15`)** — the output contract, read last:

> When your task is complete, call `subagent_report` with your full result in the
> `result` argument. That call is what the caller receives and what closes this pane —
> do not skip it. Write your final assistant message as that same self-contained summary;
> if the report does not arrive, the caller reads it instead.

**2. The tool's own `description`** — the only text a model sees when deciding whether to
call it, and the reason the old tool was invisible:

> Finish this subagent and hand your result back to the agent that spawned you. Pass the
> complete result text — not a summary of where to find it. Calling this closes the pane.

## Delegation is unchanged

A one-line note in `PROMPT_GUIDELINES` — the parent is told to end its turn and wait,
doing nothing else, and the result still arrives as one steer message. The change is *what* that message contains and
*when* the child can produce it.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `REPORT_TOOL_NAME` constant |
| `src/children/child.ts` | the tool path uses a new `writeResultReport(result)` emitting `{type:"done",result}`; the legacy `writeReportFile(settle, detail?)` still emits content-free reports for the settle and failure paths; both share one atomic temp-file+rename writer |
| `src/children/launch.ts` | reminder in `buildTaskMarkdown` only — it serializes whatever `tools` it is handed; the injection belongs to `spawn.ts` |
| `src/children/spawn.ts` | inject `REPORT_TOOL_NAME` into the expanded tool list |
| `src/children/watcher.ts` | `readReport` reads `result`; `via: "report"` outcome |
| `src/present/steer.ts` | `statusLabel` gains the `report` case |
| `docs/intent.md` | carve-out on line 24 for the injected report tool |
| `test/{children/child,children/watcher,present/steer,children/launch,children/spawn}.test.ts` | see below |

## Commands

```
Typecheck: npm run typecheck
Test:      npm test
Smoke:     npm run smoke:tool
```

## Code style

Match the existing house style: module-level doc comment stating the *why*, comments that
explain reasoning rather than restating code, full-sentence error messages that name the
fix. Ternary chains and `satisfies` are in use; no classes; no new dependencies.

## Testing strategy

`node --test` over `test/*.test.ts`, pure-function first, real temp dirs where a sidecar
is involved. No mocking framework; stubs are hand-written objects.

New coverage:

- `child.test.ts` — report writes `{type:"done",result}` atomically and leaves no `.tmp`
  behind; a failed path returns false without throwing; the legacy signatures still work;
  a `done` settle whose sidecar write fails still requests shutdown, so the parent cannot
  hang.
- `watcher.test.ts` — a report carrying `result` classifies as `via:"report"` **and
  ignores a contradicting session file** (this is the rule that proves the payload is
  authoritative); a legacy `{"type":"done"}` still scrapes; the malformed-report test
  stands unchanged.
- `launch.test.ts` — the reminder appears in the task markdown; the report tool name
  appears in `--tools` when a role declares tools.
- `spawn.test.ts` — a role **without** `tools` frontmatter gets no `--tools` flag, and
  neither does a role whose patterns match nothing, so the injection never narrows either
  child to the report tool alone.
- `steer.test.ts` — `statusLabel` renders the reported variant.

## Boundaries

- **Always:** run `npm run typecheck` and `npm test` before calling this done; keep the
  sidecar contract purely additive; report a real failure rather than swallowing it.
- **Ask first:** changing `via` semantics for the existing variants; adding a second
  sidecar file; touching `deliver()` in `index.ts`; the parent-pull design.
- **Never:** make the report the only path (a forgetful child must still produce a
  result) — **amended by `spec-report-required.md`: the report now *is* the only automatic
  close, and an unreported turn end holds the batch until a human acts**; let the child
  import from `spawn.ts` or vice versa; weaken an existing test to make this pass; remove
  the malformed-report anti-hang rule.

## Out of scope

- A parent-side pull/fetch tool, or blocking spawns that return results as tool results.
- Parallel batching, ordering, or per-child steer messages.
- Any change to `deliver()` — still one combined steer, still `triggerTurn: true`.
- Retrying a report, or validating its contents.
- Making the child print the result to stdout.

## Success criteria

1. A child calling `subagent_report({result})` lands that exact text in the parent's
   steer message as `via:"report"`, even when the child's session file says something else.
2. A child that never calls the tool still produces a correctly-labelled result — the
   suite proves it for the settle, legacy-report, and clean-exit paths.
3. A role with a `--tools` allowlist can call the report tool without listing it.
4. A role with no `tools` frontmatter still receives no `--tools` flag, and a role whose
   patterns match nothing is not narrowed to the report tool alone.
5. The reminder is present in both the task markdown and the tool description.
6. `npm run typecheck` and `npm test` pass; `npm run smoke:tool` still delivers exactly one
   steer message, labelled `completed (reported)`.

## Open questions

1. **No cap on `result` size.** A model could paste a 5MB diff into the sidecar and into
   the steer message. Deliberately unguarded for v1 — a truncation rule would need a
   number I cannot justify yet. Flag if you want one.
2. **Reporting is only discoverable via tool list + reminder.** There is no schema-level
   enforcement of "reported exactly once". Accepted; the fallback covers it.
