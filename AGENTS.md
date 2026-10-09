# AGENTS.md

<!-- spec-memory:start -->
## Spec Memory

Index of project specs. Read the linked spec before changing the area it covers.

### docs/specs

- [docs/specs/spec-child-preflight-failure.md](docs/specs/spec-child-preflight-failure.md): A pi refusal to start must still write a failed sidecar with an optional message, so the orchestrator is not left hanging.
- [docs/specs/spec-classifier-report-check.md](docs/specs/spec-classifier-report-check.md): Moves the child report check from SystemOne HTTP to the in-process classifier when classifierModel is set; systemOne* keys keep working with a load-time deprecation warning.
- [docs/specs/spec-code-layout.md](docs/specs/spec-code-layout.md): Splits index.ts and reorganizes src/ into role folders via five ordered modules; behavior-preserving, only src/paths.ts reads import.meta.url.
- [docs/specs/spec-config-env.md](docs/specs/spec-config-env.md): Adds a top-level env map to the settings file, merged per key project-over-global and exported before launch-owned vars; values must be strings.
- [docs/specs/spec-panel-layout.md](docs/specs/spec-panel-layout.md): Orchestrator-first panel layout: the orchestrator keeps 3/5 of its rect and all live subagent panes share one right-hand column, split equally.
- [docs/specs/spec-project-config.md](docs/specs/spec-project-config.md): Adds a project-local <cwd>/.pi/tinysubagent.jsonc layered over the global config; scope beats filename, profiles merge by name, malformed files warn and fall back.
- [docs/specs/spec-remove-systemone-tui-rows.md](docs/specs/spec-remove-systemone-tui-rows.md): Removes the three deprecated SystemOne rows from /subagent-settings so classifierModel is the only routing control; legacy systemOne* keys still resolve and route. (status: approved)
- [docs/specs/spec-report-required.md](docs/specs/spec-report-required.md): A done settle with no subagent_report writes nothing and keeps the child pane open; only report, exit, failure, or close ends a wait.
- [docs/specs/spec-report-tool.md](docs/specs/spec-report-tool.md): Defines the subagent_report tool: the payload lives in the sidecar, not the child session, and report text is authoritative over the session scrape.
- [docs/specs/spec-settings-tui.md](docs/specs/spec-settings-tui.md): Defines /subagent-settings, a TUI editing enableProfiles and profiles in the file resolution reads; comments must survive and every change writes immediately.
- [docs/specs/spec-systemone-routing.md](docs/specs/spec-systemone-routing.md): SystemOne profile routing: a configured API key removes the profile parameter and a model picks a profile per task; project-scope keys are inert.
<!-- spec-memory:end -->
