/**
 * The seam every way of signing in goes through.
 *
 * Discord is the only one implemented, and it is implemented *behind this interface* for the same
 * reason the chat and post providers are: this is a product other people install, and a creator who
 * does not use Discord should not be unable to run their own site. Adding Google is adding a file
 * and an entry in one array; nothing outside `src/lib/server/auth/` changes.
 *
 * ### What a provider is responsible for, and what it is not
 *
 * A provider knows how to send somebody to its authorization page and how to turn the code that
 * comes back into {@link ProviderIdentity}. It does not know about cookies, sessions, roles, or
 * where the visitor was going — all of that is `./flow.ts`, once, for every provider. The split is
 * deliberate: the parts that are easy to get subtly wrong (the `state` comparison, the redirect
 * allow-listing, the cookie flags) should exist in one place rather than once per vendor.
 *
 * ### Why `arctic` rather than hand-rolled requests
 *
 * The PHP original built the authorize URL, posted the token exchange and parsed the response by
 * hand — about 200 lines, per provider. `arctic` covers roughly fifty providers with the same two
 * calls, including the PKCE handling that a hand-rolled flow usually skips. It is also the whole
 * dependency: no session library, no passport-style middleware, no framework adapter.
 */

import type { ProviderIdentity } from '../accounts.js';

/**
 * Where a provider sends the visitor, and what has to be remembered while they are gone.
 *
 * The verifier is PKCE's: a provider that does not use PKCE returns null and {@link exchange} is
 * handed null back. It is returned rather than stored by the provider because it belongs in the
 * same signed, short-lived cookie as the state, and that cookie is `./flow.ts`'s business.
 */
export interface Authorization {
	readonly url: URL;

	/** The PKCE code verifier to hand back to {@link SignInProvider.exchange}, or null. */
	readonly verifier: string | null;
}

/** One way of signing in. */
export interface SignInProvider {
	/**
	 * The provider's id, which is also the `identities.provider` value and the URL segment.
	 *
	 * Stable forever: it is written into rows. Renaming one orphans every identity it created.
	 */
	readonly kind: string;

	/** What to call it on a sign-in button. */
	readonly label: string;

	/**
	 * Whether this provider has what it needs to work.
	 *
	 * Checked before a button is rendered. A sign-in button that leads to the provider's own error
	 * page is worse than a page saying the site has not been set up, because the visitor cannot tell
	 * which end is broken.
	 */
	usable(): boolean;

	/** Where to send the visitor. `state` is generated and remembered by the caller. */
	authorize(state: string, redirectUri: string): Authorization;

	/**
	 * Turns the code the provider sent back into who signed in.
	 *
	 * Throws {@link SignInFailure} for anything that went wrong. Implementations must not put a
	 * provider's response body into the message: a failed token exchange can echo the request, and
	 * the request contains the client secret.
	 */
	identify(code: string, verifier: string | null, redirectUri: string): Promise<ProviderIdentity>;
}

/**
 * A sign-in that could not be completed.
 *
 * One error type for every provider so the callback route has one thing to catch. The message is
 * shown to the visitor, so it says what happened in plain words and never carries a token, a
 * secret, or a provider's raw response.
 */
export class SignInFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SignInFailure';
	}
}
