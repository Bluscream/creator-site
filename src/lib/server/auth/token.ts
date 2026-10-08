/**
 * A usable access token for a linked platform, renewed if it is about to stop being one.
 *
 * ### The gap this closes
 *
 * `connections.ts` could store a credential and replace it; `./oauth2.ts` could exchange a refresh
 * token. Nothing joined them, which meant a Twitch link worked for about four hours and then
 * silently stopped — and the only symptom would be a feed that quietly stopped filling and a live
 * badge that never lit. Neither points at the token that expired.
 *
 * So every capability that needs to call a platform as the creator asks here, rather than reading
 * `credentialFor` directly and each deciding for itself what "expired" means.
 *
 * ### Renewed early, not on failure
 *
 * The alternative is to use the token, notice a 401, refresh and retry. That is more code in every
 * caller, it turns one request into three on every expiry, and a 401 does not only mean "expired" —
 * a revoked link and a missing scope answer the same way, and retrying those is pointless.
 *
 * Checking the stored expiry costs nothing because it is already in the row. {@link SKEW_SECONDS} is
 * the margin: a token valid for another few seconds is not worth handing to a request that still has
 * to cross the network.
 *
 * ### What a caller gets, and what it does not
 *
 * A string or null. Null for every reason a platform cannot be called right now — nothing linked, a
 * link holding no token, a credential that cannot be decrypted, a refusal, a platform unreachable —
 * because a caller can act on none of those differences, and the ones worth diagnosing are logged
 * here where they happen.
 *
 * Nothing in this module puts a token in a log, a message or an error. That is the whole reason it
 * returns `string | null` rather than a result object somebody would be tempted to serialise.
 */

import { credentialFor, refreshCredential } from '../connections.js';
import { log } from '../log.js';
import { accountPlatform } from './platform-registry.js';

/**
 * How long before expiry a token is treated as already expired.
 *
 * Two minutes. Long enough that a request which takes a while to get going does not set out holding
 * a token that dies on the way, short enough that it does not throw away most of a token's life. A
 * platform issuing tokens shorter than this would refresh on every call, which is a reason to raise
 * the token's lifetime rather than lower this.
 */
export const SKEW_SECONDS = 120;

/** Unix seconds. */
function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * An access token for a platform, or null.
 *
 * Renews it first when it is within {@link SKEW_SECONDS} of expiry and the link has a refresh token
 * to do it with.
 */
export async function platformToken(platform: string): Promise<string | null> {
	const credential = credentialFor(platform);

	// Nothing linked, or the credential could not be decrypted — which `credentialFor` has already
	// logged, because it is the only place that knows the difference.
	if (credential === null) return null;

	// A link that holds no token at all. Discord's is like this on purpose: it asks for `identify`
	// and nothing else, so its token unlocks nothing worth storing. Not a failure, just not a
	// credential.
	if (credential.accessToken === null) return null;

	if (!expiring(credential.expiresAt)) return credential.accessToken;

	return renew(credential.id, platform, credential.refreshToken);
}

/**
 * Whether a token is close enough to expiry to be treated as expired.
 *
 * A null expiry means the platform does not expire this token — Twitch says so with `expires_in: 0`
 * — and is **not** treated as expired. Reading null as "unknown, so refresh" would refresh a token
 * on every single call for exactly the platforms that need it least.
 */
function expiring(expiresAt: number | null): boolean {
	return expiresAt !== null && expiresAt - SKEW_SECONDS <= now();
}

/** The refresh, and storing what came back. */
async function renew(
	id: string,
	platform: string,
	refreshToken: string | null
): Promise<string | null> {
	// Kept on its object rather than plucked into a local. `refresh` is a method, and a detached
	// method loses its `this` — which works for the providers here only because they close over
	// everything they need, and would break silently for one written any other way.
	const provider = accountPlatform(platform)?.oauth ?? null;

	if (refreshToken === null || provider?.refresh === undefined) {
		// A token somebody pasted by hand, or a platform with no refresh flow. Expected, and the
		// account page already says such a link has to be re-made — so this is a warning about a thing
		// to do rather than an error about a thing that broke.
		log().warn(
			{ platform, refreshable: refreshToken !== null },
			'a linked account has expired and cannot be renewed; it has to be connected again'
		);

		return null;
	}

	let tokens;

	try {
		tokens = await provider.refresh(refreshToken);
	} catch (cause) {
		// The provider's own message, which this seam guarantees carries no token and no response
		// body. Never the cause object, which would.
		log().warn(
			{ platform, reason: cause instanceof Error ? cause.message : 'unknown' },
			'renewing a linked account failed'
		);

		return null;
	}

	if (!refreshCredential(id, tokens)) {
		// The row went away between reading it and writing it — unlinked in another tab. The token in
		// hand would work, but handing back a credential for a link that no longer exists is how a
		// platform keeps being called after somebody disconnected it.
		log().warn({ platform }, 'a renewed token had no row to be stored on; it was discarded');

		return null;
	}

	return tokens.accessToken;
}
