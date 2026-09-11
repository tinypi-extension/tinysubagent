/**
 * Preflight: the refusal pi is about to raise for a run that never starts.
 *
 * One failure is not a settle, because no run happened: pi validates the selected
 * model and the provider's credentials inside `prompt()` and *throws* before the
 * agent phase begins when either is missing — "No API key found for oc-openai"
 * being the common one. No run means no `agent_end` and no `agent_settled`, so the
 * settle hook never fires and the orchestrator waits forever on a child that is
 * sitting at its prompt having done nothing.
 *
 * The `input` hook is the one place that can see this coming: it fires inside the
 * same `prompt()` call, immediately before the validation. This module repeats
 * pi's preflight — the cheap configured check, then the provider lookup pi would
 * fall back to — and, when both come back empty, produces the failure message the
 * caller reports itself.
 *
 * No intra-repo imports: the verdict must stay independently testable and must
 * not pull the child's sidecar writer or the spawn side into its cycle.
 */

/**
 * Why pi will refuse to start a run, in the words the orchestrator reads.
 *
 * Phrased as a diagnosis and a fix, because the orchestrator cannot see the
 * child's pane and has no other way to learn which provider needs attention.
 * `cause` is set only when the credential lookup itself failed, where naming the
 * failure beats guessing at its shape.
 */
export function preflightFailure(input: {
	provider: string | null;
	usesOAuth: boolean;
	cause: string | null;
}): string {
	if (input.provider === null) {
		return "pi could not start this subagent: no model is selected — check the profile's model and retry.";
	}
	if (input.cause !== null) {
		return (
			`pi could not start this subagent: could not resolve credentials for ` +
			`"${input.provider}" — ${input.cause}`
		);
	}
	if (input.usesOAuth) {
		return (
			`pi could not start this subagent: authentication for "${input.provider}" failed ` +
			`(credentials expired, or the provider is unreachable) — run /login ${input.provider}.`
		);
	}
	return (
		`pi could not start this subagent: no API key configured for "${input.provider}" — ` +
		`run /login ${input.provider}.`
	);
}

/** The registry surface the preflight reads, so the verdict stays testable. */
export interface PreflightRegistry {
	hasConfiguredAuth(model: { provider: string }): boolean;
	getProviderAuthStatus(provider: string): { configured: boolean };
	getProviderAuth(provider: string): Promise<unknown>;
	isUsingOAuth(model: { provider: string }): boolean;
}

export interface PreflightContext {
	model: { provider: string } | undefined;
	modelRegistry: PreflightRegistry;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The refusal pi is about to raise, or null when it will start the run.
 *
 * Mirrors `AgentSession.prompt`'s validation in order, cheaply: a credential the
 * registry already knows about settles it, and only the case it cannot answer
 * resolves one. Resolving is the heavier step — it can refresh an OAuth token or
 * reach the network — so taking it first would fail children pi would have run.
 */
export async function preflightRefusal(ctx: PreflightContext): Promise<string | null> {
	const model = ctx.model;
	if (!model) return preflightFailure({ provider: null, usesOAuth: false, cause: null });

	const { modelRegistry } = ctx;
	const provider = model.provider;
	if (modelRegistry.hasConfiguredAuth(model)) return null;
	if (modelRegistry.getProviderAuthStatus(provider).configured) return null;

	let resolved: unknown;
	try {
		resolved = await modelRegistry.getProviderAuth(provider);
	} catch (error) {
		// pi's own lookup can fail the same way, and this child cannot tell whether
		// it would have: reporting a failure the run may not have had is the lesser
		// evil next to an orchestrator waiting on a child that never starts.
		return preflightFailure({ provider, usesOAuth: false, cause: errorText(error) });
	}
	if (resolved !== undefined) return null;

	// Only the wording depends on this; a registry that cannot say is not a reason
	// to lose the report, so the failure stands.
	let usesOAuth = false;
	try {
		usesOAuth = modelRegistry.isUsingOAuth(model);
	} catch {
		usesOAuth = false;
	}
	return preflightFailure({ provider, usesOAuth, cause: null });
}
