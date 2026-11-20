# 04: Rex interrupt and outcome close parity

**What to build:** Stopping a Rex batch feels the same as stopping a herdr batch. Esc reaches every live child block by ID, the wait ends as interrupted, and the blocks that were stopped are closed. Every other outcome — completed, failed, cancelled — gets herdr's close behavior without hanging the batch.

**Blocked by:** 02: Rex single-child batch returns its report.

**Status:** resolved

- [ ] Esc in the orchestrator's Rex block relays to every live child block by full ID, not by focus or label.
- [ ] An interrupted wait ends with the `interrupted` outcome and closes the child blocks it stopped; a shutdown wait leaves them open, as in herdr.
- [ ] A child block that vanishes without a report or exit code makes that child `cancelled` and does not hang the batch.
- [ ] Completed, failed, cancelled and interrupted children have the same close behavior in Rex as in herdr, including leaving a turn-end completion's block open as the only evidence.
- [ ] Fake-`rex` CLI tests cover Esc send-key, full-ID targeting, close calls, vanished-block detection and outcome-specific close behavior; herdr interrupt and watcher tests remain unchanged.
- [ ] No real Rex blocks are created or closed during verification without explicit permission.

## Comments

- 2026-11-20: Implemented on `ticket/rex-04-interrupt` in `316ee9d`, `7881bc2` and `0f8619a`: Rex relays Esc by full block ID, two-child interrupt and shutdown parity, and outcome close parity (report/session-exit close; turn-end, failed, cancelled and shutdown stay open; vanished block cancels without hanging). Fake `rex` CLI only; herdr path unchanged. `npm test` 551 pass, `npm run typecheck` clean; integration tip merged (already up to date).
