# Spec: default tools for every child, and `-` negation in a role's `tools`

Status: ready-for-agent

Source: an interview with the user on 2026-10-12. Every decision below marked
*(interview)* was confirmed explicitly; the two marked *(delegated)* were answered "up to you"
and are stated so they can be reversed in one edit. Extends
`docs/issues/project-config/spec.md` (the settings file, its scopes, its layering rule) and
`docs/issues/report-tool/spec.md` (the report tool, always present in a child). Contradicts
neither, nor `docs/issues/agy-harness/spec.md`'s rule that agy cannot enforce a role `tools`
allowlist.

## Problem Statement

Every role must restate the tools it wants. There is no way to say "every child gets
`read`, `bash`, `edit`, `write`, and the codegraph tools" once, so a user who wants a common
floor either duplicates the same list into every role file or leaves roles with no `tools`
frontmatter at all — and a role with no `tools` frontmatter gets **no allowlist**, which in
pi means *every tool the child's harness has*, far more than the user intended.

The mirror problem is subtraction. A role can only author an allowlist of names and globs.
It cannot say "everything, except `write`", because pi's wildcard grammar has no negation
and tinysubagent passes a plain-name allowlist that replaces the whole selection. So the
natural request — *give all children this floor, but this role must not have `write`* — has
no expression today.

The user's original ask was a `!`-prefixed negation (`!grep`). That spelling was rejected
in the interview: pi already uses `-name` inside `--tools` and `--exclude-tools` for the
same idea, and one dialect is better than two.

## Solution

A new top-level `defaultTools` key in `tinysubagent.jsonc`: an array of plain tool names
that every child starts with. It is deliberately dumb — names only, no `*`, no `-`, no
`!` — so it reads as a floor, not a program.

A role's `tools` frontmatter gains negative entries: `-write` removes `write` from the
final list, and `-*` drops the `defaultTools` floor entirely so a narrow role can keep
being narrow. The child is still launched with a plain-name `--tools` allowlist; negation
is resolved by tinysubagent before launch and never reaches pi as a flag.

`defaultTools` is a plain list of names — there is no glob and no negation inside it.

```jsonc
// ~/.pi/agent/tinysubagent.jsonc
{ "defaultTools": ["read", "bash", "edit", "write", "codegraph_query", "codegraph_search"] }
```

```markdown
<!-- <project>/.pi/agents/reviewer.md -->
---
name: reviewer
description: Read-only review
tools: -write, -edit        # floor, minus the two mutating tools
---
```

```markdown
<!-- a role that must not inherit the floor -->
---
name: planner
tools: -*, read, grep, find, ls
---
```

## User Stories

1. As an orchestrator user, I want to set a list of tools that every child starts with, so
   that I stop copying the same allowlist into every role file.
2. As an orchestrator user, I want the floor to live in my global config, so that every
   project on my machine gets it without each repo opting in.
3. As a repository maintainer, I want to set `defaultTools` in the project config, so that
   contributors get the tools this codebase's roles need.
4. As a repository maintainer, I want a project `defaultTools` to replace my global one
   wholesale, so that a repo can narrow what my machine-wide floor allows.
5. As an orchestrator user with no `defaultTools` configured, I want behaviour byte-identical
   to today, so that upgrading changes nothing.
6. As a role author, I want to remove one tool from the floor with `-write`, so that a
   read-only role cannot mutate files without me restating the whole list.
7. As a role author, I want `-*` in `tools` to drop the floor, so that a narrow role stays
   narrow when someone later widens `defaultTools`.
8. As a role author, I want `-*` to compose with a list (`-*, read, grep`), so that I can
   express "exactly these, no floor" in one line.
9. As a role author, I want `*` to keep working in a positive entry, so that my existing
   `codegraph_*` roles are unaffected.
10. As a role author, I want a negative entry to beat a positive one regardless of order, so
    that `-write, write` and `write, -write` mean the same thing and I never have to think
    about ordering.
11. As a role author, I want a negative entry to beat the floor too, so that `-bash` on a
    role wins over `bash` in `defaultTools`.
12. As an orchestrator user, I want a `defaultTools` entry I misspelt to warn instead of
    silently doing nothing, so that a typo surfaces.
13. As an orchestrator user, I want a `*` or `-name` written in `defaultTools` to warn at
    startup and be dropped, so that I learn the key has no grammar before wondering why a
    glob did nothing.
14. As an orchestrator user, I want `defaultTools` that is not an array, or holds a
    non-string, to warn and be ignored, so that a config mistake never blocks delegation.
15. As an orchestrator user, I want a role that ends up with zero tools to still start, so
    that a bad negation is a visible warning rather than a refused spawn.
16. As an orchestrator user, I want that empty case to launch with only the report tool, so
    that negation narrows the child rather than accidentally widening it to everything.
17. As an orchestrator user, I want `subagent` in `defaultTools` to be dropped with a warning
    rather than refusing every spawn, so that a floor I wrote for its other names still works.
18. As a role author, I want naming `subagent` in a role's `tools` to stay a refusal, so that
    the nested-delegation rule is unchanged and the mistake is mine to fix.
19. As an orchestrator user, I want the report tool to be present whatever the floor and
    whatever the negations say, so that no configuration can produce a child that cannot
    hand its result back.
20. As a role author, I want `-subagent_report` ignored with a warning, so that I learn it is
    not a capability I can withhold.
21. As an orchestrator user, I want `defaultTools` problems reported once at startup or on the
    first spawn of the session, so that they do not drown the role-specific warning on every
    single acknowledgment.
22. As an orchestrator user running an agy profile, I want `defaultTools` ignored with a
    warning, so that setting it does not refuse every agy spawn.
23. ~~As an orchestrator user running an agy profile for a role that declares `tools`, I
    want the existing refusal to stay, so that the rule I document is the rule I get.~~
    **Corrected 2026-10-29:** as an orchestrator user running an agy profile for a role that
    declares `tools`, I want the list ignored with a warning and the spawn to proceed, so
    that a role written for pi still launches on agy. There was no existing refusal to keep;
    see **agy** below.
24. As a reader of the README, I want the `tools` notes to say what the floor does to a role
    with no `tools` frontmatter, so that I understand the blast radius before setting it.
25. As a reader of the README, I want `*` documented as including `subagent`, so that I know
    why `*` refuses to spawn and how to write `-*` instead.
26. As a maintainer, I want the tool-list composition in one pure function, so that the
    union/subtraction rule is testable without spawning a pane.
27. As a user of `/subagent-settings`, I want the screen untouched, so that this change cannot
    break profile editing.

## Implementation Decisions

**The key.** *(interview)* Top-level `defaultTools` in the settings file, plural to match
pi's own `defaultTools` setting. An array of plain tool names. *(interview)* No `*` and no
`-` grammar inside it: a glob or negation written there is a shape error, not an expression.

**Absent means empty.** *(interview)* The resolved config always carries an array; an absent
key resolves to `[]`. Because absence and `[]` are indistinguishable, `[]` is **not**
warned about — it is the documented default state, exactly as an absent `env` is an empty
map.

**Layering.** *(interview)* The highest-precedence file that specifies `defaultTools` wins
with its **whole array**; there is no union and no per-entry merge. This mirrors
`enableProfiles` (highest scope that states the key wins) rather than `profiles`/`env`
(merge by name), because a merge can only ever widen a floor and the point of a project
override is usually to narrow it. The `PI_TINYSUBAGENT_CONFIG` override still short-circuits
and remains the only file read.

**Shape errors.** *(interview)* A `defaultTools` that is not an array, and any non-string
entry, warn and are dropped — the rest of the key still applies. An entry containing `*`, or
beginning with `-`, is likewise dropped with its own warning naming that entry, rather than
being passed through as a literal name. Warning text keeps the house form used by `env` and
`profiles`: `tinysubagent: defaultTools entry "-write" in <file> is not supported; ignoring it.`

**Negation spelling.** *(interview)* A role `tools` entry beginning with `-` is a negation.
The originally suggested `!` prefix is not implemented. pi spells the same idea `-name`
inside `--tools` and `--exclude-tools`; supporting both would leave two dialects where one
is enough. Negation is resolved by tinysubagent, not passed to pi — the child still receives
a plain-name allowlist, so pi's "plain names and `+name`/`-name` cannot be mixed" rule is
never in play.

**`-*` drops the floor.** *(interview)* A `-*` entry in a role's `tools` means "do not
inherit `defaultTools`". It composes left-to-right with the rest of the list — `-*, read,
grep` yields exactly `read`, `grep`. It is not a negation that matches every name, it is the
opt-out, so it produces no unmatched warning and is a no-op when the floor is already empty.
This is what stops a narrow role from silently widening when the floor widens.

**Composition.** *(interview, delegated detail)* The final list is the union of positives
(floor names plus role positives, with `*` in role positives expanded against the
orchestrator's tool registry) minus the union of negatives (role negatives, with `*` only in
the form of the `-*` opt-out). **Deny wins, order-independently**: `-write, write` and
`write, -write` both exclude `write`, and a role negation beats a floor name. First-seen
order is preserved for the argv string so acknowledgments stay stable.

**Allowlist intent.** *(delegated)* "Intent to constrain" exists iff the role declares
`tools` **or** the floor is non-empty. With intent, the child gets an explicit allowlist.
Without it, no `--tools` flag is passed and the child inherits its harness's normal tool
set — today's behaviour, unchanged.

**Empty after subtraction.** *(interview)* The spawn proceeds normally. Concretely, with
intent present and the composed list empty, the child launches with `--tools
subagent_report` and a warning in the acknowledgment that the allowlist is empty. It does
**not** launch with no flag, because that would mean *everything* and turn a narrowing
mistake into a widening one.

**Negatives only.** *(delegated, added 2026-10-29)* A role whose `tools` holds only negations
(`-write`, or `-write, -edit`) is asking to narrow even when the floor is empty. It therefore
has intent and launches with `--tools subagent_report` plus the empty-list warning, rather
than with no flag: no flag would hand the child every tool, including the one the role just
removed. Opting out (`-*`) and the ignored report-tool negation remove nothing, so on an
empty floor they stay the no-flag case, and so does an unmatched positive pattern — an empty
expansion is not an allowlist (see **The report tool**).

**The report tool.** *(interview)* `subagent_report` is appended to every explicit allowlist
after composition, whatever the floor and negations say. A role's `-subagent_report` is
ignored with a warning rather than honouring it: the report is the hand-back contract, not a
capability. The existing guard comment stands — an empty expansion is not an allowlist, and
a role with no declared `tools` on an empty floor gets no flag at all.

**`subagent` in the floor.** *(interview)* A floor entry naming `subagent` is dropped with a
warning; it is never a refusal. Ambient config the user wrote for its other names must not
block every spawn in the project.

**`subagent` in a role.** *(interview)* Naming `subagent` in a role's `tools` stays a
**refusal**, unchanged, tests included. A role declaring `*` also keeps refusing, because
`*` expands over the registry and the registry contains `subagent`. The README gains the
explanatory line rather than the guard gaining an exception.

> **Corrected 2026-10-29.** The guard shipped deny-wins, so it *did* gain the exception the
> original expected to avoid. The decision is now: `tools: "*", -subagent` and
> `tools: "subagent, -subagent"` launch, while a bare `subagent` or a `*` with no
> subtraction still refuses. The reason is the same one that makes negation win everywhere
> else: a name the role subtracts was never in its child, so refusing on it would make the
> documented `*`-with-`-subagent` workaround impossible. The README documents `-subagent`
> beside `-*`; the refusal is for a spawn tool that survives the role's own negations.

**agy.** *(interview)* `defaultTools` is ignored for an agy profile with a warning on the
spawn, and the role-declares-`tools` refusal is unchanged. A floor is ambient, so it
degrades; a role's own declaration is the role's mistake, so it refuses.

> **Corrected 2026-10-29.** The premise was wrong: `main` already warned and launched for a
> role that declares `tools` on an agy profile (test `an agy profile ignores role tools with
> a warning and proceeds`). The shipped code keeps that baseline for both the floor and a
> role's list, because agy has no `--tools` flag and a refusal would make every pi role with
> a `tools` entry unusable there. User story 23 is corrected with it.

**Warning channels.** *(interview)* Shape errors and unsupported entries are reported through
the existing config-load warning channel at startup, beside the current `env`/`profiles`
messages. Problems that need the tool registry — a floor name matching no tool, a dropped
`subagent`, an ignored `-subagent_report` — are reported on the **first spawn of the
session only**, then go quiet, so they cannot bury a role-specific warning on every
acknowledgment. Role-level unmatched patterns keep their current per-spawn behaviour.

**Unmatched floor names.** *(delegated)* A floor name that matches nothing in the registry is
kept in the allowlist and warned about, matching the existing rule for literal role names
("a renamed tool warns instead of silently narrowing the list"). A **negative** entry that
matches nothing also warns, because a `-noshuchtool` typo is the same class of mistake.

**No settings-screen work.** *(interview)* `/subagent-settings` is untouched; the key is
file-only for now. An editor for an array of names with an opt-out entry is its own issue.

**Vocabulary.** `GLOSSARY.md` gains **Default tools** (the names every child starts with
unless a role removes them) and **Tool list** (a role's `tools` frontmatter, the floor plus
its positives minus its negations), stated without implementation detail. The glossary's
"Role" and "Profile" entries are unchanged.

## Testing Decisions

**What makes a good test here.** Only the composed allowlist counts: given a floor, a role's
`tools`, and a registry, which names come out — plus what the child actually gets on its
command line and what the user is warned about. No test asserts on internal step order, on
intermediate sets, or on how negation is parsed.

**Seams — one new, two existing.**

1. **New, highest available: a pure tool-list resolver.** One function taking the floor
   entries, the role's raw entries, and the tool registry, returning the final names, a
   warning list, and whether an allowlist exists at all. Every grammar rule above (union,
   deny-wins, `-*`, empty-after-subtraction, unsupported floor entries, `subagent` drop,
   report-tool append) is asserted here, with no filesystem and no pane. This is the seam
   that should carry almost all the coverage.
2. **Existing, config loader.** Layering assertions — project replaces the whole array,
   absent resolves to `[]`, wrong types warn — against the current config-loading tests'
   style of writing real files into a temp directory and inspecting the resolved config.
3. **Existing, spawn.** One integration assertion that the resolver's result reaches the
   child's argv, that the agy warning fires, and that the `subagent` refusal still refuses.
   The existing spawn tests already build a fake spawn context with a tool registry, which is
   the right prior art to extend.

**Prior art.** The tool-pattern tests are the model for the resolver's table-driven cases; the
config tests are the model for scope layering and warning text; the spawn tests are the model
for asserting argv and acknowledgment warnings together.

**Regression gate.** The claim "no `defaultTools` means today's behaviour" is proven by the
existing suites passing unmodified. Any test that has to change for behaviour is listed
explicitly in the plan, not adjusted quietly.

## Out of Scope

- A `/subagent-settings` editor for `defaultTools`.
- Any change to pi's own `defaultTools` setting, or to how the child's pi settings file is
  found. The two defaults compose by pi's rules (tinysubagent passes `--tools`, which replaces
  pi's selection) and that interaction is documented, not reimplemented.
- `*` or `-` grammar inside `defaultTools`.
- Per-profile `defaultTools`.
- Nested delegation, or making `subagent` available to a child.
- agy tool enforcement.
- Migrating or rewriting anyone's existing config files.
- A `+name` positive verb (pi's additive form) in role frontmatter.

## Further Notes

- The user's opening request was `defaultTool` (singular) with `!grep`. Both spellings were
  changed deliberately during the interview: plural to match pi's own key, `-` to match pi's
  own dialect.
- Setting a floor is a **behaviour change for every role in every project that has no
  `tools` frontmatter**, since such a role stops inheriting everything and starts inheriting
  the floor. The README must say this plainly, and `-*` is the documented answer for a role
  that wants the old breadth.
- `defaultTools` cannot express "everything". A name the user has not listed is a tool the
  child will not have, and the only way to grant breadth is to name it or to unset the key.
  That is intentional — a floor written in globs is a policy the user cannot read.
- The floor expands against the **orchestrator's** tool registry (`pi.getAllTools()`), which
  is what the child's registry is derived from but is not guaranteed identical. This is the
  same limitation the existing role globs already live with; no new machinery is proposed.
