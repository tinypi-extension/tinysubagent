# 05: Registry-dependent warnings say their piece once

**What to build:** A floor that needs the tool registry to be checked does not repeat itself on every acknowledgment. An unmatched floor name, a dropped `subagent` entry, and an ignored `-subagent_report` are each reported on the first spawn of the session and then stay quiet, while a role's own unmatched patterns keep warning on every spawn they affect. Config shape errors are unaffected and remain startup-only, where ticket 01 put them.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [x] The first spawn of a session reports an unmatched floor name; later spawns in the same session do not repeat it.
- [x] The same once-per-session rule applies to a dropped `subagent` floor entry and to an ignored `-subagent_report`.
- [x] A role's own unmatched tool pattern still warns on every acknowledgment for that role.
- [x] The warning channel for config shape errors still reports at startup and is not duplicated onto spawns.
- [x] `npm test` and `npm run typecheck` pass.
