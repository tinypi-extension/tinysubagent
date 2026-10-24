# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `docs/issues/`.

## Conventions

- One feature per directory: `docs/issues/<feature-slug>/`
- The spec is `docs/issues/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `docs/issues/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Supporting documents sit beside the spec when they are narrative, not tickets: `plan.md` (implementation plan) and `spike.md` (research results)
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)

## Legacy: `todo.md` checklists

`todo.md` files are pre-existing checklists (`- [x]` / `- [ ]` items with `Files:` and acceptance notes) that were never split into per-ticket files. They are **historical and read-only**: don't restructure them, don't add new items to them. New ticket work goes to `issues/<NN>-<slug>.md`.

## When a skill says "publish to the issue tracker"

Create a new file under `docs/issues/<feature-slug>/` (creating the directory if needed). New tickets go in `issues/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the feature slug directly.

## Naming

The directory keeps the slug only — no `spec-` prefix. `docs/specs/spec-code-layout.md` (pre-migration path) is now `docs/issues/code-layout/spec.md`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `docs/issues/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/issues/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `docs/issues/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
