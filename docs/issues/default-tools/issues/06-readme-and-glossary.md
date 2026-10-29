# 06: README and glossary

**What to build:** A reader learns the floor's blast radius before they set it. The role `tools` notes state plainly that a role with no `tools` frontmatter stops inheriting everything and starts inheriting the floor, `defaultTools` gets its own section with an example, `-*` gets an example beside it, and `*` is documented as including `subagent` with the `-*` / `-subagent` workaround. The glossary gains **Default tools** and **Tool list** with no implementation detail, and the project's spec index lists this issue.

**Blocked by:** 01, 02, 03, 04, 05

**Status:** ready-for-agent

- [x] The `tools` notes say what setting a floor does to a role that declares no `tools`.
- [x] The README documents `defaultTools`, its whole-array scope layering, its name-only grammar, and that `[]` and an absent key mean the same thing.
- [x] The README shows `-name` and `-*` examples, and explains that `*` includes `subagent`.
- [x] The agy note says the floor and a role `tools` list are both ignored with a warning while the spawn proceeds (ticket 04 changed this from refusal).
- [x] `GLOSSARY.md` defines **Default tools** and **Tool list** without implementation detail.
- [x] The project spec index lists `docs/issues/default-tools/spec.md`.
- [x] `npm test` and `npm run typecheck` pass.
