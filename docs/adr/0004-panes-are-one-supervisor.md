# Panes are one supervisor, not the seam itself

The spawn path was built against a `PaneHost`, which quietly assumed every child owns a pane. That
assumption is what kept the tool out of a plain terminal. We widened the seam to a **Supervisor** —
open a child, learn when its wait ends, stop it, close it — and made a pane host one implementation
of it beside the plain-terminal one that supervises a process. The pane-host adapter keeps its
operations and behaviour unchanged behind a conformance wrapper.

The alternative, an adapter that fakes pane operations it cannot honour (`childExists` on a
process, `relayInterrupt` typing Esc into nothing), was rejected: it would have made every call site
ask "is this a real pane?" anyway, only later and less honestly.

Consequences: layout, rename, resize and interrupt-by-Esc stay behind the pane-host adapter and are
reachable only when the chosen supervisor is a pane host. Behaviour that differs between kinds lives
in one per-kind spawn recipe; waiting, report reading, reminding and the batch result stay shared.
`GLOSSARY.md` relaxed its old invariant accordingly — every child supervised by a pane host owns a
pane; a plain-terminal child is supervised as a process.
