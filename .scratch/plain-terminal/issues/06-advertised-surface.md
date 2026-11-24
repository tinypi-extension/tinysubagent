# 06: The advertised surface matches the mode

**What to build:** Nothing the orchestrator is told promises a pane it will not get. The tool description and prompt snippet describe what the current mode will actually do, the profile list offered in a plain terminal contains only profiles that can run there, routing considers only those, and an explicit request for a profile that cannot run is refused with the reason instead of ignored — while the settings UI still lists and edits every configured profile for the sessions where they will work.

**Blocked by:** 02.

**Status:** resolved

- [x] In a plain terminal, the prompt snippet and the description no longer claim the child runs in a pane, and no longer narrate layout or a pane column.
- [x] Under a pane host, every word of today's description and snippet is unchanged.
- [x] Profiles backed by a harness that cannot run in a plain terminal are absent from the profile list the model is offered.
- [x] Routing considers only the profiles that can run in the current mode, so a plain-terminal batch is never routed into one that cannot start.
- [x] An explicit request for a filtered profile is refused with a reason that names why it is unavailable here.
- [x] The current profile is never filtered, so the offered list may legitimately contain only current.
- [x] The settings UI still lists and edits every configured profile in any mode.
- [x] A batch of children whose harnesses differ fails only the children that cannot run here, and the rest still run.

## Resolution

Landed on `plain-terminal`: `c166eea` (merge d183c9b). `resolveProfile`/`availableProfileNames`/`profileParamDescription`/`buildToolDescription`/`buildLaunchScript` take a launch mode; agy-backed profiles are filtered at that one authority so the list, routing and the unknown-name error move together, while an explicit request is refused with a reason and the settings UI stays unfiltered. Description and prompt snippet lose the pane and the layout narration only in plain mode.
