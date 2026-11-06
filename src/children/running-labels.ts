/**
 * The Labels this registration's running subagents have reserved.
 *
 * A Label is what tells one Spawn's pane, ack, and report from its siblings', so
 * two children running under the same Label make the whole batch ambiguous. The
 * reservation is taken in one synchronous step — check and claim together — so
 * an overlapping tool call cannot slip past the check, and it is released when
 * that child's wait settles, whatever the outcome.
 *
 * Scope is this extension instance: a Label reserved here says nothing about a
 * subagent another instance or another pane started.
 */

export class RunningLabels {
	private readonly labels = new Set<string>();

	/** Claim `label` for a Spawn; false when a running subagent already holds it. */
	reserve(label: string): boolean {
		if (this.labels.has(label)) return false;
		this.labels.add(label);
		return true;
	}

	/** Give `label` back, so a later Spawn may use it. */
	release(label: string): void {
		this.labels.delete(label);
	}
}
