# AGENTS.md

<!-- spec-memory:start -->
## Spec Memory

Index of project specs. Read the linked spec before changing the area it covers.

### docs/issues

- [docs/issues/child-preflight-failure/spec.md](docs/issues/child-preflight-failure/spec.md): Superseded by silent-errors: a pi refusal to start writes nothing and the child waits at its prompt for a human.
- [docs/issues/code-layout/spec.md](docs/issues/code-layout/spec.md): Splits index.ts and reorganizes src/ into role folders via five ordered modules; behavior-preserving, only src/paths.ts reads import.meta.url.
- [docs/issues/config-env/spec.md](docs/issues/config-env/spec.md): Adds a top-level env map to the settings file, merged per key project-over-global and exported before launch-owned vars; values must be strings.
- [docs/issues/default-tools/spec.md](docs/issues/default-tools/spec.md): Adds a top-level `defaultTools` floor that every child starts from, with `-name` subtraction and `-*` opt-out in a role's `tools`; the floor is names only and layers as a whole array.
- [docs/issues/agy-harness/spec.md](docs/issues/agy-harness/spec.md): Allows profiles to select pi or agy, with shared thinking levels (mapped to agy's effort flag), project-cwd execution with untouched project hooks, report-sidecar completion, and tested child outcomes.
- [docs/issues/panel-layout/spec.md](docs/issues/panel-layout/spec.md): Orchestrator-first panel layout: the orchestrator keeps 3/5 of its rect and all live subagent panes share one right-hand column, split equally.
- [docs/issues/project-config/spec.md](docs/issues/project-config/spec.md): Adds a project-local <cwd>/.pi/tinysubagent.jsonc layered over the global config; scope beats filename, profiles merge by name, malformed files warn and fall back.
- [docs/issues/remove-systemone-tui-rows/spec.md](docs/issues/remove-systemone-tui-rows/spec.md): Removes the three deprecated SystemOne rows from /subagent-settings so classifierModel is the only routing control; legacy systemOne* keys still resolve and route. (status: approved)
- [docs/issues/report-required/spec.md](docs/issues/report-required/spec.md): A done settle with no subagent_report writes nothing and keeps the child pane open; only report, exit, or close ends a wait.
- [docs/issues/report-tool/spec.md](docs/issues/report-tool/spec.md): Defines the subagent_report tool: the payload lives in the sidecar, not the child session, and report text is authoritative over the session scrape.
- [docs/issues/settings-tui/spec.md](docs/issues/settings-tui/spec.md): Defines /subagent-settings, a TUI editing enableProfiles and profiles in the file resolution reads; comments must survive and every change writes immediately.
- [docs/issues/silent-errors/spec.md](docs/issues/silent-errors/spec.md): An errored or unstartable run is held at its pane like an unreported turn end; the child writes only success (status: needs-triage).
- [docs/issues/systemone-routing/spec.md](docs/issues/systemone-routing/spec.md): SystemOne profile routing: a configured API key removes the profile parameter and a model picks a profile per task; project-scope keys are inert.
<!-- spec-memory:end -->

## Agent skills

### Issue tracker

Issues live as markdown under `docs/issues/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, strings unchanged, recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
