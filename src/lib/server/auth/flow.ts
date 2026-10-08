/**
 * The sign-in round trip: starting it, and finishing it.
 *
 * Everything here is provider-independent, which is the point. The parts of an OAuth flow that are
 * easy to get subtly wrong — comparing the `state`, deciding where a visitor may be sent afterwards,
 * the cookie flags, clearing the pending flow whether or not it succeeded — exist once rather than
 * once per vendor. A provider (`./sign-in-provider.ts`) supplies a URL and an identity and knows
 * nothing about any of this.
 *
 * ### The pending flow is a cookie, not a server-side session
 *
 * While the visitor is away at the provider, three things have to be remembered: the `state` to
 * compare, the PKCE verifier if the provider uses one, and where they were going. All three go in
 * one short-lived `HttpOnly` cookie. The alternative — a row, or an in-memory map — would need
 * sweeping, would not survive a restart mid-flow, and would make a sign-in attempt a database write
 * available to anyone who can reach the login route.
 *
 * {@link PENDING_TTL} is ten minutes: long enough to approve a prompt and short enough that an
 * abandoned attempt is not still usable tomorrow.
 *
 * **What the `state` check does and does not protect.** Comparing a cookie against a query parameter
 * stops a third party who can make the victim's browser issue the callback request — the ordinary
 * login-CSRF case — because they cannot read or set that cookie. It does not stop somebody who can
 * already write cookies for this site, who could plant both halves; that attacker can do worse
 * things than force a sign-in, and no state parameter helps. `next` is reduced by
 * {@link safePath} regardless of where it came from, so even a planted cookie can only send the
 * visitor to a path on this site.
 *
 * ### Where the visitor goes afterwards
 *
 * Only to a path on this site, and only one that looks like a path. An admin login link is exactly
 * the sort of thing somebody would like to append `?next=https://elsewhere` to, so anything that is
 * not a plain local path is discarded rather than cleaned up — see {@link safePath}, which is the
 * same rule the PHP original applied, for the same reason.
 */

import { oauthState } from './oauth2.js';
import type { Cookies } from '@sveltejs/kit';
import { DISCORD_REDIRECT_URI } from '$app/env/private';
import { linkIdentity, signIn } from '../accounts.js';
import type { Principal } from '../session.js';
import { SESSION_COOKIE, SESSION_TTL, issue, revoke, sameToken } from '../session.js';
import { log } from '../log.js';
import { registrationPolicy, roleFloorFor } from './policy.js';
import type { LinkMethod } from '../db/schema.js';
import { link as linkConnection } from '../connections.js';
import type { LinkRefusal } from '../connections.js';
import { SignInFailure } from './sign-in-provider.js';
import type { Callback, Grant, SignInProvider } from './sign-in-provider.js';
import type { ProviderIdentity } from '../accounts.js';

/**
 * The part of SvelteKit's `Cookies` this module uses.
 *
 * Named rather than taking the whole `RequestEvent`, because what these functions need is a URL and
 * three cookie operations — and a parameter that says so is both easier to read and testable without
 * standing up a request. SvelteKit's own `Cookies` satisfies it, so a route passes `event` unchanged.
 */
export type CookieJar = Pick<Cookies, 'get' | 'set' | 'delete'>;

/** What the flow needs to know about a request. */
export interface FlowRequest {
	readonly url: URL;
	readonly cookies: CookieJar;
}

/** The cookie a flow in progress lives in. */
export const PENDING_COOKIE = 'creator_oauth';

/** How long a flow in progress stays valid, in seconds. */
export const PENDING_TTL = 10 * 60;

/** Where a visitor ends up when they did not ask for anywhere in particular. */
export const DEFAULT_DESTINATION = '/admin';

/** Where somebody manages their own sign-in methods and sessions. */
export const ACCOUNT_PATH = '/admin/account';

/**
 * What a local path may contain.
 *
 * An allow-list rather than a list of characters to reject. The rejecting form has to enumerate
 * every control character, every separator and every encoding of them, and the one that is
 * forgotten is the one that matters; this form fails closed on anything it was not written to
 * expect. Letters, digits and the punctuation a URL path, query and fragment are actually made of —
 * `#` among them, because a redirect to an anchor on a page is a reasonable thing to ask for and a
 * fragment cannot leave this origin.
 */
const PLAIN_PATH = /^\/[\w\-./~%?&=:@+,;!$'()*#[\]]*$/u;

/**
 * What a flow is for.
 *
 * `sign-in` is the ordinary case. `link` adds another way to sign in to the account that is *already*
 * signed in, which is a different thing entirely: the identity that comes back must be attached to
 * the existing user rather than becoming one, and an identity somebody else already holds must be
 * refused rather than moved.
 *
 * `connect` is the third, and it is not the same as `link` even though the round trip is identical.
 * A `link` writes an `identities` row — a bare pointer saying this person may sign in this way. A
 * `connect` writes a `connections` row, which holds the credential and the granted scopes and is
 * what the post, chat, live and socials capabilities read. Two tables because a row that can sign
 * you in and a row that holds an API token have different blast radii; two intents for the same
 * reason, so neither is ever written where the other was meant.
 */
export type Intent = 'sign-in' | 'link' | 'connect';

/** Every value {@link Intent} can take, for validating one that arrived in a query string. */
export const INTENTS: readonly Intent[] = ['sign-in', 'link', 'connect'];

/** What is remembered while the visitor is at the provider. */
interface Pending {
	readonly kind: string;
	readonly state: string;
	readonly verifier: string | null;
	readonly next: string;
	readonly intent: Intent;

	/**
	 * For a `link`, whose account it is for.
	 *
	 * Compared against who is signed in when the callback arrives, so a flow started by one person
	 * cannot finish against another's account — which is what would happen on a shared browser where
	 * somebody signed out and back in while the first tab was away at the provider.
	 */
	readonly userId: string | null;
}

/**
 * Reduces a `next` parameter to a same-origin absolute path, or to `fallback`.
 *
 * Anything that is not a plain local path — a scheme, a host, a protocol-relative `//evil`, a
 * control character — is discarded rather than sanitised. Rejecting is safe; repairing a hostile
 * string is a game of finding the encoding nobody thought of.
 *
 * @param fallback where to go when the candidate is absent or refused. Signing *in* defaults to the
 *                 admin; signing *out* defaults to the public site, which is why this is a parameter
 *                 rather than one constant.
 */
export function safePath(
	candidate: string | null | undefined,
	fallback: string = DEFAULT_DESTINATION
): string {
	const value = (candidate ?? '').trim();

	// `//evil.example` is a protocol-relative URL, not a path, and every browser follows it off
	// this site. It passes the allow-list, so it is refused separately.
	if (value.startsWith('//') || !PLAIN_PATH.test(value)) return fallback;

	return value;
}

/**
 * Where the provider should send the visitor back to.
 *
 * Derived from the request, because this site answers on several hostnames and each one registers
 * its own redirect; `DISCORD_REDIRECT_URI` pins it for a deployment where that does not hold. The
 * origin is whatever the request says it is, which behind a proxy means `PROTOCOL_HEADER` and
 * `HOST_HEADER` have to be set — see `compose.yaml`. Getting that wrong shows up immediately as the
 * provider refusing a redirect it does not recognise, which is the right way for it to fail.
 */
export function redirectUriFor(kind: string, url: URL): string {
	if (kind === 'discord' && DISCORD_REDIRECT_URI !== undefined) return DISCORD_REDIRECT_URI;

	return new URL(`/auth/${kind}/callback`, url.origin).toString();
}

/**
 * Starts a sign-in: remembers the flow and says where to send the visitor.
 *
 * @returns the provider's authorization URL
 */
export async function beginSignIn(
	provider: SignInProvider,
	event: FlowRequest,
	options: { readonly intent?: Intent; readonly userId?: string } = {}
): Promise<URL> {
	const state = oauthState();
	const redirectUri = redirectUriFor(provider.kind, event.url);
	const { url, verifier } = await provider.authorize(state, redirectUri);
	const intent = options.intent ?? 'sign-in';

	remember(event.cookies, {
		kind: provider.kind,
		state,
		verifier,
		next: safePath(event.url.searchParams.get('next')),
		intent,
		userId: intent === 'sign-in' ? null : (options.userId ?? null)
	});

	return url;
}

/** What finishing a flow produced. */
export interface CompletedSignIn {
	readonly principal: Principal;

	/** Where to send the visitor now. Already reduced by {@link safePath}. */
	readonly next: string;

	/** What the flow was for, so the caller can report "linked" rather than "signed in". */
	readonly intent: Intent;
}

/**
 * Finishes a sign-in, or throws {@link SignInFailure} saying why not.
 *
 * The pending cookie is cleared first, before anything can fail, so a flow is single-use whatever
 * happens to it. A visitor who refreshes a failed callback gets "start again" rather than a second
 * attempt at the same code — which the provider would reject anyway, with a worse message.
 */
export async function completeSignIn(
	provider: SignInProvider,
	event: FlowRequest,
	signedIn: Principal | null = null
): Promise<CompletedSignIn> {
	const pending = forget(event.cookies);
	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');

	// A provider that was declined sends `error=access_denied` and no code. Not a failure worth a
	// scary message: the visitor pressed cancel.
	if (code === null || state === null) {
		throw new SignInFailure('The sign-in was cancelled.');
	}

	if (pending === null) {
		throw new SignInFailure('That sign-in link has expired. Please start again.');
	}

	// Constant-time, through `sameToken`: an early-exit `===` on a secret leaks the position of the
	// first difference, and the state is the only thing standing between a forged callback and a
	// session.
	if (pending.kind !== provider.kind || !sameToken(pending.state, state)) {
		throw new SignInFailure('That sign-in could not be verified. Please start again.');
	}

	const redirectUri = redirectUriFor(provider.kind, event.url);

	// One exchange, whichever intent this is. An authorization code is single-use, so asking for the
	// identity and then for the grant would have the provider reject the second call.
	// The whole callback query, not just the code. `./oauth2.ts` explains why: the library will not
	// accept parameters that did not pass its own validator, and that validator also rejects an
	// `error=` response and duplicated parameters, neither of which the comparison above looks at.
	//
	// `expectedState` is the cookie's state, which is the one that means anything — handing the
	// library the callback's own state would have it compare a value against itself.
	const callback: Callback = {
		params: event.url.searchParams,
		expectedState: pending.state,
		verifier: pending.verifier,
		redirectUri
	};

	if (pending.intent === 'connect') {
		const grant = await grantOf(provider, callback);

		return { principal: connect(grant, pending, signedIn), next: pending.next, intent: 'connect' };
	}

	const identity = await provider.identify(callback);

	if (pending.intent === 'link') {
		return { principal: link(identity, pending, signedIn), next: pending.next, intent: 'link' };
	}

	const result = signIn(identity, registrationPolicy(), { floor: roleFloorFor(identity) });

	if (!result.ok) {
		log().warn({ provider: identity.provider, reason: result.reason }, 'sign-in refused');

		throw new SignInFailure(
			result.reason === 'registration_closed'
				? 'This site is not accepting new accounts.'
				: 'That sign-in could not be completed.'
		);
	}

	start(event.cookies, result.principal);

	return { principal: result.principal, next: pending.next, intent: 'sign-in' };
}

/**
 * Attaches a new identity to the account that started the flow.
 *
 * No session is issued: the person is already signed in, and issuing another would leave a second
 * row behind for no reason. The checks are the ones that keep this from being a way to take over
 * somebody's account:
 *
 * - the flow must have been started by whoever is signed in *now*, not merely by somebody
 * - the identity must not already belong to anybody, including to this same account
 */
function link(identity: ProviderIdentity, pending: Pending, signedIn: Principal | null): Principal {
	if (signedIn === null) {
		throw new SignInFailure('You have to be signed in to add another way of signing in.');
	}

	if (pending.userId !== signedIn.userId) {
		// A shared browser where somebody signed out and back in while the first tab was away at the
		// provider. Refusing is the only safe answer: the alternative attaches one person's identity
		// to whoever happens to hold the session now.
		throw new SignInFailure('That request was started by a different account. Please try again.');
	}

	if (!linkIdentity(signedIn.userId, identity)) {
		// Including when this same account already has it, where there is nothing to add. Refusing
		// rather than reassigning, because moving an identity between accounts is how one person takes
		// over another's.
		throw new SignInFailure('That account is already in use for signing in here.');
	}

	return signedIn;
}

/**
 * The credential to keep, or the identity alone for a provider with nothing worth keeping.
 *
 * A provider without `grant` is not an unfinished one: Discord asks for `identify` and nothing else,
 * so its token unlocks exactly what the identity already said. The connection is then a handle, a
 * display name and an avatar — which is all the socials capability wants — and no secret is written
 * to disk at all.
 */
async function grantOf(provider: SignInProvider, callback: Callback): Promise<Grant> {
	if (provider.grant !== undefined) return provider.grant(callback);

	return {
		identity: await provider.identify(callback),
		accessToken: null,
		refreshToken: null,
		expiresAt: null,
		scopes: []
	};
}

/**
 * Writes the linked account the flow was started to create.
 *
 * The same two checks as {@link link}, because the ways this could go wrong are the same: a flow
 * finishing against an account that is not the one that started it, and an account somebody else
 * already holds. What differs is the refusal, because the reasons differ — `connections` refuses a
 * platform account that another user has linked, and refuses everything when no `SECRET_KEY` is set,
 * since a token that cannot be encrypted must not be written in the clear.
 */
function connect(grant: Grant, pending: Pending, signedIn: Principal | null): Principal {
	if (signedIn === null) {
		throw new SignInFailure('You have to be signed in to link an account.');
	}

	if (pending.userId !== signedIn.userId) {
		throw new SignInFailure('That request was started by a different account. Please try again.');
	}

	keepGrant(grant, signedIn.userId, 'oauth');

	return signedIn;
}

/**
 * Writes a grant as a linked account, whichever method produced it.
 *
 * Shared by the OAuth callback and the paste-a-token form, because the *credential* half of linking
 * is identical once a grant exists — the same row, the same refusals, the same encryption. Only the
 * ceremony before it differs: a round trip with a state cookie, or a form field.
 *
 * `method` is recorded rather than inferred, because it changes what the account page can say: an
 * OAuth link can be re-authorised with a button, a pasted one has to be pasted again.
 *
 * @throws {SignInFailure} with a message for whoever asked for the link
 */
export function keepGrant(grant: Grant, userId: string, method: LinkMethod): void {
	const { identity } = grant;
	const result = linkConnection({
		userId,
		platform: identity.provider,
		platformAccountId: identity.providerUserId,
		handle: identity.name ?? null,
		displayName: identity.name ?? null,
		avatarUrl: identity.avatarUrl ?? null,
		method,
		accessToken: grant.accessToken,
		refreshToken: grant.refreshToken,
		expiresAt: grant.expiresAt,
		scopes: grant.scopes
	});

	if (typeof result === 'string') {
		// The reason, never the grant: it holds the token.
		log().warn({ platform: identity.provider, method, reason: result }, 'link refused');

		throw new SignInFailure(refusalMessage(result));
	}
}

/** What to tell somebody whose link was refused. */
function refusalMessage(reason: LinkRefusal): string {
	switch (reason) {
		case 'already_linked':
			return 'That account is already linked to somebody else here.';
		case 'no_secret_key':
			// Worth saying plainly: it is the operator's missing configuration, not the person's
			// mistake, and no amount of retrying will change it.
			return 'This site cannot store linked accounts yet. Its SECRET_KEY has not been set.';
	}
}

/** Ends the session the request is carrying, if any. */
export function signOut(event: { readonly cookies: CookieJar }): void {
	const token = event.cookies.get(SESSION_COOKIE);

	if (token !== undefined) revoke(token);

	event.cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** Issues a session and sets the cookie. */
function start(cookies: CookieJar, principal: Principal): void {
	const { token } = issue(principal.userId);

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		// `lax` rather than `strict`: the callback arrives as a top-level navigation from the
		// provider, and `strict` would withhold the cookie on exactly that request — so the visitor
		// would land signed out and try again forever. `lax` still withholds it from cross-site
		// `POST`s, which is what matters for a form.
		sameSite: 'lax',
		secure: true,
		maxAge: SESSION_TTL
	});
}

/** Stores a flow in progress. */
function remember(cookies: CookieJar, pending: Pending): void {
	cookies.set(PENDING_COOKIE, JSON.stringify(pending), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge: PENDING_TTL
	});
}

/**
 * Reads and deletes the flow in progress.
 *
 * Deleted whether or not it parsed, so a cookie this version cannot read does not keep failing on
 * every attempt until the visitor clears it themselves.
 */
function forget(cookies: CookieJar): Pending | null {
	const raw = cookies.get(PENDING_COOKIE);

	cookies.delete(PENDING_COOKIE, { path: '/' });

	if (raw === undefined) return null;

	return parsePending(raw);
}

/** A pending flow as it was stored, or null for anything else. */
function parsePending(raw: string): Pending | null {
	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof value !== 'object' || value === null) return null;

	const { kind, state, verifier, next } = value as Record<string, unknown>;

	if (typeof kind !== 'string' || typeof state !== 'string' || state === '') return null;

	const { intent, userId } = value as Record<string, unknown>;

	return {
		kind,
		state,
		verifier: typeof verifier === 'string' ? verifier : null,
		// Anything but an exact word this version knows is the ordinary flow. A cookie claiming an
		// intent this build does not have should sign somebody in, not attach an identity or write a
		// credential — the unrecognised case must fail towards the least powerful of the three.
		intent: intent === 'link' || intent === 'connect' ? intent : 'sign-in',
		userId: typeof userId === 'string' && userId !== '' ? userId : null,
		// Re-checked on the way out as well as on the way in: this value came back from the
		// visitor's browser, and a cookie is not a place where a check made earlier still holds.
		next: safePath(typeof next === 'string' ? next : null)
	};
}
