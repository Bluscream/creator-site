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

/**
 * What a provider's callback produced.
 *
 * The whole query rather than just the code, because `oauth4webapi` will not accept callback
 * parameters that did not pass through its own validator — which is what makes skipping the state
 * comparison impossible rather than merely inadvisable, and which is also what turns
 * `error=access_denied` into a refusal rather than a missing code noticed later.
 *
 * `expectedState` is the state from the **cookie**, not from the callback. The library can only
 * compare the value it is handed, so handing it the callback's own state would prove nothing; the
 * check that binds the response to this browser is `./flow.ts`'s, and this is how its answer reaches
 * the exchange.
 */
export type { Callback } from './oauth2.js';

import type { Callback } from './oauth2.js';

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

	/**
	 * Where to send the visitor. `state` is generated and remembered by the caller.
	 *
	 * Asynchronous because PKCE's code challenge is a SHA-256 of the verifier, and every runtime this
	 * targets offers that only through `crypto.subtle`, which is async.
	 */
	authorize(state: string, redirectUri: string): Promise<Authorization>;

	/**
	 * Turns the code the provider sent back into who signed in.
	 *
	 * Throws {@link SignInFailure} for anything that went wrong. Implementations must not put a
	 * provider's response body into the message: a failed token exchange can echo the request, and
	 * the request contains the client secret.
	 */
	identify(callback: Callback): Promise<ProviderIdentity>;

	/**
	 * The same exchange, but keeping the credential — for linking an account rather than signing in.
	 *
	 * Optional, and its absence is a real answer rather than an unfinished one. Discord asks for
	 * `identify` and nothing else, so its access token buys exactly what {@link identify} already
	 * returned: keeping it would mean storing a secret that unlocks nothing anybody needs later. A
	 * platform like that is linked for its handle and its avatar, and the row holds no token at all.
	 *
	 * Where it *is* implemented, it must exchange the code once. Calling {@link identify} as well
	 * would present the same authorization code twice, which every provider rejects the second time.
	 */
	grant?(callback: Callback): Promise<Grant>;
}

/**
 * What came back from an exchange worth keeping.
 *
 * `scopes` is **what the provider actually granted**, not what was asked for. Several of these
 * platforms quietly narrow a request — a person can untick a permission on the consent screen — and
 * a stored list of what was requested makes a capability look available right up until the call that
 * needs it fails. Empty where a provider does not say.
 */
export interface Grant {
	readonly identity: ProviderIdentity;

	/** Null for a provider whose token is of no use after the exchange. */
	readonly accessToken: string | null;

	/** Null where the provider issues none, which means the link is re-authorised by hand. */
	readonly refreshToken: string | null;

	/** Unix seconds, or null for a token the provider does not expire. */
	readonly expiresAt: number | null;

	readonly scopes: readonly string[];
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
