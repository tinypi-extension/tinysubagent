# Spec: `env` map in the settings file

Status: agreed, **implemented**. Source: an interview with the user on the shape of
`"env": { "name": "value" }`; every decision below that is marked *(interview)* was
confirmed explicitly. Two decisions (assumptions 8 and 10) were delegated to me with "up
to you" rather than confirmed, and are labelled as defaults so either can be reversed in
one edit. Extends `docs/spec-project-config.md` (the file, its scopes, its merge rule) and
contradicts neither it nor `docs/intent.md`.

## Assumptions I'm making

1. **Plain names, no prefix added and none required** *(interview)*. `"env": { "FOO": "bar" }`
   puts `FOO=bar` in the child. The extension never rewrites `FOO` to `SUBAGENT_FOO`, and
   never demands the `SUBAGENT_` prefix back.
2. **The child's process only** *(interview)*. The orchestrator's own environment is never
   mutated; a variable set here is invisible to the orchestrator session that spawned the
   child.
3. **Config beats inherited** *(interview)*. The child already inherits the orchestrator's
   environment through the pane; a mapped value overrides that inherited value. Otherwise
   the map would be a no-op exactly when it is most needed (overriding a shell export).
4. **Launch-owned variables win** *(interview)*. `PATH`, `PI_CODING_AGENT_DIR`, and every
   `PI_TINYSUBAGENT_*` the wrapper sets are not overridable from the config file. This is
   achieved by ordering, not by a blocklist — see *Emission order*.
5. **Per-key merge across scopes, project over global** *(interview)*. Same rule the spec
   already states for `profiles`: a repo file adds a variable without restating the user's
   personal ones. The `PI_TINYSUBAGENT_CONFIG` override still short-circuits and becomes
   the only file read, so `env` is not merged from any scope in that mode.
6. **A bad entry warns and is ignored** *(interview)*. Non-string value, or `env` that is
   not an object: skip what is bad, keep the rest, push a warning through the channel that
   already exists (tool description + `session_start` notify). A config typo must not
   disable delegation, and must not stop a spawn.
7. **`""` is a value, not "unset"** *(interview)*. `"FOO": ""` exports an empty `FOO` — the
   map's whole job is to state values, and blanking an inherited variable is a real use.
   There is no syntax for "unset"; the user deletes the key.
8. **A key must be a POSIX shell identifier** — `[A-Za-z_][A-Za-z0-9_]*`. *Delegated: the
   user answered "up to you".* A key like `"a b"` or `"x=y"` cannot
   be exported (`export 'a b'=x` is not valid bash) and would corrupt the whole generated
   wrapper rather than the one variable, so such a key is skipped with a warning under
   rule 6. The alternative — pass it through and let bash fail — trades one missing
   variable for a dead pane, which is a strictly worse failure.
9. **Warning text keeps the house form**: `tinysubagent: env "FOO" in <file> is not a
   string; ignoring it.` — names the file, names the key, says "ignoring", matching the
   existing `profile "..." in ...` / `"profiles" is not a JSON object` wording.
10. **Values are strings, and nothing else** — *delegated: the user asked "should value
    support different type? number, boolean …", then "up to you".* Numbers, booleans and
    `null` are rejected with a warning under rule 6, exactly like any other non-string.
    The reasoning is in *Value types* below; it is the same posture as rule 8 — the loader
    never guesses what the author meant.

Both 8 and 10 are defaults taken on delegation, not interview answers. They are the only
two such decisions in this spec, and both are stated so they can be reversed in one edit
before implementation.

## Current behaviour (verified, not assumed)

- `buildLaunchScript` (`src/children/launch-script.ts:50`) is the only place child
  environment is composed. It emits a bash wrapper whose exports are, in order:
  `PATH` (`:69`), `PI_CODING_AGENT_DIR` when the project has its own agent dir (`:72`),
  `PI_TINYSUBAGENT_NAME|ID|SESSION|REPORT|PANE` (`:77`), `PI_TINYSUBAGENT_AGENT` when a
  role is named (`:84`). Then `cd <cwd>`, then the pi command.
- The wrapper is generated from literal options only. Its caller is `spawnChild`
  (`src/children/spawn.ts:105`), which already has the loaded config in hand as
  `SpawnContext.config: TinysubagentConfig` (`src/children/contract.ts:54`).
- `PI_HERDR_LAUNCH_SCRIPT` is passed to `herdrPaneOpen` (`src/children/spawn.ts:151`) as
  the *pane's* env, one level above the wrapper. Nothing in this spec touches it.
- Values are interpolated with `shellEscape` (`src/children/launch-script.ts:16`), the
  single quoting form in the file. A mapped value must go through it too: a value is
  user text and must not be word-split or expanded by the shell.
- `loadConfig` (`src/config/config.ts:295`) reads lowest-precedence first and overwrites,
  recognising a key by **presence** (`Object.hasOwn`). `mergeProfiles` owns the profile
  case; `env` needs its own merge before the loop on that pattern.
- The settings TUI rewrites only the paths it edits, via `modify`/`applyEdits`
  (`src/config/draft.ts:183`). An `env` key it does not know about is therefore preserved
  byte-identically; no draft change is required by this spec.
- No `env` key is read today, and nothing tests one. `test/config/config.test.ts` covers
  scopes and merge for `profiles`/`enableProfiles` only.

## Objective

Let a settings file hand a spawned subagent the variables that child needs — keys, base
URLs, feature flags — so the user does not have to export them machine-wide, repeat them
per spawn, or edit a launch script. One file, one map, applied to every child.

## Scope check

One capability. No capability map. It does not add a way to configure per-role or
per-profile variables, and it does not make the orchestrator's environment configurable.

## Resolution rule (authoritative)

```jsonc
{
  "env": { "FOO": "bar", "EMPTY": "" }
}
```

- `env` is a top-level key, a sibling of `profiles` and `enableProfiles`. It is **not**
  nested under `profiles` and is not a per-profile key.
- The effective map is the union of every scope read, key by key, with the higher scope
  winning: `override` (when `PI_TINYSUBAGENT_CONFIG` is set) > `project` > `global`. Within
  a directory `.jsonc` still beats `.json`, and scope still beats filename.
- `TinysubagentConfig` gains `env: Record<string, string>`, always present and `{}` when
  nothing was set — so no caller needs a null check, and `env: {}` is a legal no-op.
- Every key in the effective map is exported into every spawned child, single and
  parallel, any role, any profile. Absent `env` changes nothing.

## Emission order

The map is emitted as `export` lines **before** every launch-owned export, so the
ordering itself is the collision rule (assumption 4) — there is no blocklist to keep in
sync with the file:

```
#!/usr/bin/env bash
trap '' TSTP
export FOO='bar'            # <- config env, in the config's key order
export EMPTY=''
export PATH='...'           # launch-owned: wins over a config "PATH"
export PI_CODING_AGENT_DIR='...'
export PI_TINYSUBAGENT_*    # launch-owned: identity and report paths
cd '...'
<pi command>
```

Consequence, stated plainly: a config `"PATH": "/tmp"` is exported and then immediately
overwritten, i.e. silently ineffective. That is deliberate and is why assumption 4 exists.
A warning for launch-owned keys was considered and rejected: the set would have to be
enumerated in one more place, and "the machinery that starts the child wins" is a rule the
user can hold in their head.

Entered values go through `shellEscape`, exactly like every other literal in the script,
so `'`, `$`, spaces, and newlines in a value are inert.

## Merge semantics

```jsonc
// global  ~/.pi/tinysubagent.jsonc        {"env": {"FOO": "global", "BAR": "global"}}
// project <repo>/.pi/tinysubagent.jsonc   {"env": {"FOO": "project"}}
// result                                  {"FOO": "project", "BAR": "global"}
```

Key order in the generated script follows the effective map's insertion order: global keys
first (lowest precedence is read first), with a project key that overrides an existing key
keeping its position. Order is cosmetic — bash does not care — so no code should sort, and
no test should assert an order that a later merge reshuffles.

## Failure behaviour

| Input | Result |
|---|---|
| `"env": {"A": "1", "B": 5}` | `A` exported; `B` skipped with one warning; spawn proceeds |
| `"env": {"DEBUG": false}` | `DEBUG` skipped with one warning; spawn proceeds. **Not** exported as `"false"` — see *Value types* |
| `"env": {"X": null}` / `{"X": {"a": 1}}` / `{"X": [1]}` | `X` skipped with one warning; spawn proceeds |
| `"env": ["A"]` / `"env": "A"` / `"env": 5` | whole map dropped, one warning; spawn proceeds |
| `"env": {"a b": "1"}` | key skipped (assumption 8), one warning; spawn proceeds |
| `"env": {"PATH": "/tmp"}` | exported, then overwritten by the wrapper; no warning |
| `"env": {}` / key absent | nothing emitted, no warning |
| unparseable JSONC | out of scope — the existing loader path already owns this |

Warnings ride the existing `warnings: string[]` from `loadConfig` through
`SpawnContext.config`'s sibling — the same channel a bad `profiles` entry uses today — so
they surface in the tool description and the `session_start` notify with no new plumbing.

## Deliberate non-behaviour

- **No prefix, and no prefix enforcement.** A name the user writes is the name the child
  gets, including a name that collides with a real variable. The only thing standing
  between the config and the child's `PATH` is the emission order.
- **No expansion.** No `$VAR`, `${VAR}`, or `~` handling on the value side. `"HOME_DIR":
  "$HOME/x"` reaches the child as the literal `$HOME/x`, because the value is single-quoted
  — an escape hatch here would mean deciding when a value is a template and when it is
  data, and the child can expand it itself if it wants to.
- **No unset syntax.** Deleting the key is the way to stop exporting a variable.
- **No `env` editing in the settings TUI.** The screen keeps writing `profiles` and
  `enableProfiles` only; an `env` block it does not touch survives every TUI edit.
- **No validation of value *content*.** A string is always legal, including one the
  child's tooling will reject. Only the *type* (string) and the *key shape* are checked;
  what goes into a variable is the author's business.
- **No coercion, ever.** No number is stringified, no boolean is read as a flag, no `null`
  is read as "unset". A value that is not a JSON string is a warning, not an interpretation
  — see *Value types*.

## Files

| File | Change |
|---|---|
| `src/config/config.ts` | read `env` per source, merge into `TinysubagentConfig.env`, warn on bad shapes (`mergeEnv`) |
| `src/children/launch-script.ts` | `LaunchScriptOptions.env?: Record<string,string>`; emit the exports before the launch-owned block |
| `src/children/spawn.ts` | pass `context.config.env` into `buildLaunchScript` |
| `test/config/config.test.ts` | scopes, per-key merge, bad shapes, warnings |
| `test/children/launch.test.ts` | emission, quoting, order vs. `PATH` |
| `test/children/spawn.test.ts` | the wiring: a mapped var reaches the generated script |

Untouched: `src/config/draft.ts`, `src/config/agents.ts`, `src/config/models.ts`,
`src/config/profiles.ts`, `src/pi/tool.ts` (the config already travels in
`SpawnContext`), `index.ts`, the herdr modules, `docs/intent.md`.

## Commands

```
npm run typecheck          # tsc --noEmit
npm test                   # node --test "test/**/*.test.ts"
npm run smoke:tool         # end-to-end: a spawned child really sees the variable
```

## Testing strategy

Unit, at the two seams that own the behaviour:

1. **Config** (`test/config/config.test.ts`) — the existing fixture helper writes scopes
   into a temp dir, so the cases are: `env` read from one file; project-over-global per
   key with the global-only key surviving; `.jsonc` over `.json`; override short-circuit
   ignoring both scopes; `{"A":"1","B":5}` yielding `A` plus one warning naming `B` and
   the file; a non-object `env` yielding `{}` plus one warning; `""` surviving as `""`;
   absent `env` yielding `{}` with no warnings. Assert the **map**, never the key order.
2. **Launch script** (`test/children/launch.test.ts`) — `buildLaunchScript` returns text,
   so assert on lines, not on a shell: an `export FOO='bar'` line exists; a value with a
   quote round-trips escaped (`test's` → `'test'\''s'`); a newline in a value stays inside
   the quoting; the config export lines all precede `export PATH=`; `env` omitted emits no
   `env`-derived line and leaves the existing script byte-identical (the existing
   assertions must not be weakened to make room).
3. **Wiring** (`test/children/spawn.test.ts`) — a spawn with `config.env` set writes a
   script file containing the export. This is the only test that would catch
   `spawn.ts` forgetting to pass the map.
4. **Smoke** (`npm run smoke:tool`) — a real child asked to report `$FOO`, confirming the
   export survives bash, the dispatcher, and pi's own environment handling. This is the
   test that cannot be faked by a unit test, since it crosses a process boundary.

## Boundaries

- `env` is read only by the config loader, and only from the three config scopes. It is
  never read from `settings.json`, from an agent's frontmatter, or from `.envrc` — the
  launch prefix already owns the `.envrc` case.
- The wrapper is generated per spawn and is never edited after generation. Nothing here
  introduces a long-lived environment store.
- No new file, no new directory, no new herdr call, no new tool parameter.

## Out of scope

- Per-role and per-profile `env` blocks.
- Mutating the orchestrator's environment, or passing variables back *up* from a child.
- Removing or unsetting inherited variables (there is no "unset" syntax).
- Secrets management: a value here is plaintext in a file that is normally committed.
  A `PI_TINYSUBAGENT_CONFIG`-style env indirection was not requested and is not designed.
- Reading `env` in `scripts/smoke*.ts` beyond what the smoke already does.

## Success criteria

1. `"env": {"FOO": "bar"}` in either scope puts `FOO=bar` in a spawned child, visible to
   the child's own shell and to `pi` inside it, in a single spawn and in a parallel batch.
2. The orchestrator's own `process.env` is unchanged before and after a spawn.
3. A config `"PATH"` or `"PI_TINYSUBAGENT_REPORT"` cannot break a spawn: the wrapper's
   value is what the child gets.
4. A project file overriding one key does not drop the global file's other keys.
5. Every malformed input in *Failure behaviour* produces a warning and a working spawn —
   never a failed spawn and never a corrupted wrapper.
6. A value containing `'`, a space, or a `$` reaches the child verbatim and unexpanded.
7. `npm run typecheck`, `npm test`, and `npm run smoke:tool` pass.

## Implementation notes

- `mergeEnv(root, file, env, warnings)`: mirror `mergeProfiles`'s shape — presence-checked
  (`Object.hasOwn(root, "env")`), shape-checked, then per-key assignment. A key that is
  already present is overwritten in place, which is what keeps the insertion order above.
- Reading `env` in the loader loop, not after it: the override short-circuit and the
  project-outranks-global rule then come for free, and cannot drift from `profiles`.
- In `buildLaunchScript`, take `env` as a plain optional record and emit
  `export ${key}=${shellEscape(value)}` per entry. Key order comes from
  `Object.entries`; do not sort.
- Filter keys with a `/^[A-Za-z_][A-Za-z0-9_]*$/` check at **load** time, not at emission
  time, so the warning names the file the user has to edit. A key that fails is not in
  `config.env` at all, so no consumer can be handed an unexportable name.
- Emit the block immediately after the `trap '' TSTP` line and before `export PATH=`. A
  one-line comment in the generated script (`# tinysubagent: env from config`) keeps the
  ordering's purpose visible to anyone reading a wrapper on disk.

## Resolved decisions

1. **Plain names** — no `SUBAGENT_` prefix added, none required. Asked directly; the answer
   was "no start with SUBAGENT_, use plain name".
2. **Child-only** — the map targets the subagent process, not the extension. Asked
   directly; the answer was "subagent's process".
3. **Per-key merge, project over global** — the same rule as `profiles`, confirmed.
4. **Warn and ignore** on malformed input, through the existing warning channel; `""` is a
   real value, not an unset. Confirmed as a batch with one yes.
5. **Launch-owned variables win by emission order** — flagged in the interview, confirmed
   as part of the collision rule.
6. **Key-shape validation** — delegated ("up to you"), so taken as a default: assumption 8.
   Invalid identifiers are skipped with a warning rather than passed to bash, because
   `export 'a b'=x` breaks the entire wrapper instead of the one variable.
7. **String-only values** — delegated as well (the user asked whether numbers and booleans
   should be supported, then "up to you"), so taken as a default: assumption 10 and the
   *Value types* section. Strings only. The rejected alternatives, and why, are recorded
   there rather than left implicit.

### Value types

The question was whether `"PORT": 3000` and `"DEBUG": false` should work. They do not.
Values are JSON strings. Three reasons, strongest first.

1. **`false` is truthy in the child.** Node coerces a boolean to the string `"false"`
   (verified on Node 24: `spawnSync` with `false`/`true`/`null`/`0` exits 0 and the child
   sees `false`, `true`, `null`, `0`). So `"DEBUG": false` puts the literal text `false`
   into the environment, and `[ -n "$DEBUG" ]`, `${DEBUG:-no}`, and every `if [ "$DEBUG" ]`
   in every script read that as **on**. A config that says `false` would turn the flag on.
   Accepting booleans is worse than rejecting them, because the failure is silent and
   backwards.
2. **JSON numbers are lossy on the way to a string.** A number in JSONC goes through
   IEEE754 before it can be stringified, so `"PORT": 1.0` reaches the child as `"1"`
   (silent normalization) and a 19-digit numeric ID reaches it as `12345678901234567000`
   (silent corruption). Numbers are unsafe exactly for the ID-like values that are a
   common reason to want them.
3. **The gain is only ergonomic.** Every environment variable is a string on the far side
   of `execve` — the shell, `printenv` and the child see bytes, never a type. Accepting a
   number does not give the child a number; it saves the author two quote characters and
   costs every future reader a rule to remember. `"PORT": "3000"` is not hard to write.

`null` is rejected for a different reason: it has three plausible readings — unset, empty,
and the literal `"null"` — and a config format should not have to pick one. `"FOO": ""`
(rule 7) is how the author writes empty; deleting the key is how they write unset.

This matches the codebase's existing posture: `normalizeProfile` already answers a
non-string `model` with a warning and skips the field rather than coercing it.

| Alternative | Verdict |
|---|---|
| Strings only | **Chosen.** One rule, no ambiguity, no lossy path |
| Strings + numbers | Rejected — the lossy `String()` path in reason 2, and it splits the rule in two |
| All scalars via `String()` | Rejected — mirrors Node's behaviour but imports the truthy-`false` trap and the number corruption with it |
| Coerce booleans to `"1"` / `""` | Rejected — inventing a shell idiom the author did not write, and it makes `"DEBUG": "false"` and `"DEBUG": false` mean opposite things |
