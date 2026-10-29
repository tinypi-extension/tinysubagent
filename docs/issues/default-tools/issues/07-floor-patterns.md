# 07: `*` patterns in the floor

**What to build:** `defaultTools` accepts `*` patterns as well as plain names, so a user can
claim a whole tool family — `"mcp__codegraph__*"` — once instead of enumerating it and having
the floor go stale when an MCP server adds a tool. The leading `-` stays a shape error. This
implements the 2026-10-29 amendment in `docs/issues/default-tools/spec.md`; read **The key**,
**Floor patterns**, **Shape errors**, **Composition**, **Warning channels**, **Unmatched floor
patterns**, **A floor of exactly `*`** and **Testing Decisions** there before editing.

`docs/issues/default-tools/issues/01-floor-reaches-child.md` is the shipped names-only ticket.
Its text says `*` warns; that is history and must not be re-implemented.

**Blocked by:** None. Tickets 01–06 have shipped.

**Status:** ready-for-agent

## Rules

1. **One grammar.** A floor entry containing `*` is a pattern and uses `expandToolPatterns`
   from `src/tool-patterns.ts` unchanged — `*` matches any run of characters, anchored, all
   else literal. No new matcher, no new file.
2. **The loader checks shape only.** In `src/config/config.ts`, `resolveDefaultTools` keeps
   pattern entries verbatim for the resolver to expand. Only a non-string entry and an entry
   beginning with `-` are dropped with the existing warning form. The predicate exported from
   `src/tool-list.ts` must stop rejecting `*`: rename `isPlainToolName` to `isFloorEntry`
   (its one caller is `src/config/config.ts`) and update both doc comments, which currently
   argue that a glob is a shape error.
3. **Expansion is the resolver's job.** `resolveToolList` in `src/tool-list.ts` expands the
   configured floor through `expandToolPatterns(input.floor, input.registry)`. That helper
   already has the two shapes the spec wants: a literal name is kept even when the registry
   does not know it, and a pattern that matches nothing is dropped from `tools` and returned
   in `unmatched`. Do not hand-roll the split.
4. **The spawn-tool drop applies after expansion.** A floor `"*"` (or `"sub*"`) that resolves
   to `subagent` gets the same drop-and-warn as a floor that spells the name, keyed
   `defaultTools:subagent`. Never a refusal for the floor.
5. **Warnings, all once per session** through `reportedWarnings`:
   - a floor name the registry does not know: unchanged text and key
     (`defaultTools:unknown:<name>`);
   - a floor **pattern** that matched nothing: new, key `defaultTools:pattern:<pattern>`, text
     `tinysubagent: defaultTools entry "<pattern>" matched no tool — it adds nothing.`
   - a floor of **exactly** `["*"]`: new, key `defaultTools:star`, text
     `tinysubagent: defaultTools is "*", so the floor grants every tool and no longer narrows anything.`
     A `*` mixed with names (`["read", "mcp__codegraph__*"]`) says nothing.
6. **Intent is read from the configured floor**, as today: `input.floor.length > 0`. A floor
   of one pattern that matched nothing still counts as intent, so the child launches with the
   report tool alone. That empty-list warning is cause-neutral —
   `agent "<role>": the tool list is empty — only subagent_report is allowed.` — because the
   warn-once line above it already named the cause.
7. **Nothing else changes.** `-*` still drops the floor wholesale; role positives and
   negatives are untouched; agy still ignores the floor with its warning; the report tool is
   still appended to every allowlist.

## Checklist

- [x] `isFloorEntry` accepts `mcp__codegraph__*`, rejects `-write`, and the loader carries
      `"codegraph_*"` through verbatim with no warning.
- [x] A floor pattern reaches a role that declares no `tools`, expanded in registry order,
      with `subagent_report` appended.
- [x] A floor pattern that matches nothing adds nothing, is not kept as a literal entry, and
      warns once — not on the session's second spawn.
- [x] A floor of exactly `["*"]` grants every registry tool but `subagent`, drops `subagent`
      with its warning, and is acknowledged once with the text above.
- [x] A `*` mixed with names is not acknowledged.
- [x] A role's `-name` still subtracts a name that a floor pattern expanded to, and `-*` still
      drops the floor including its patterns.
- [x] `test/config/config.test.ts`: the old "entry containing `*` warns and is dropped" test is
      rewritten to assert it is kept; the `-` test is unchanged.
- [x] One spawn test asserts a floor pattern's expansion appears in the child's `--tools`
      string, following the existing `defaultTools` spawn tests.
- [x] No change to `src/tool-patterns.ts`. Any other test that changes is listed in the PR
      body, not adjusted quietly.
- [x] `npm test` and `npm run typecheck` pass.
