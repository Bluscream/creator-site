/**
 * Signing in with Kick, and linking a Kick account.
 *
 * The third provider behind `./sign-in-provider.ts`, and the first whose platform **requires** PKCE
 * rather than merely tolerating it — so it is the first where `./oauth2.ts`'s verifier path is load
 * bearing instead of a precaution.
 *
 * ### Why `/oauth/token/introspect` is the identity call
 *
 * The same reason Twitch uses `/oauth2/validate`: it is the one endpoint that answers "is this token
 * live, what may it do, and **which application does it belong to**". `public/v1/users` answers who,
 * but it cannot say whose application minted the token — and a token issued to somebody else's
 * client id is a perfectly valid Kick token this site must refuse, because its scopes were granted
 * elsewhere and its revocation is not ours.
 *
 * One call, one parser, one set of failure messages for both an OAuth exchange and a pasted token,
 * rather than a second path that could disagree with the first.
 *
 * ### Two fields that do not mean what they look like
 *
 * - Introspection's `token_type` is `"user"` or `"app"` — **not** the OAuth `Bearer`. An app token is
 *   refused here: it authenticates the application, not a person, so it cannot answer whose account
 *   this is and must never be stored as somebody's link.
 * - Introspection's `exp` is an **absolute** unix timestamp, where Twitch's `expires_in` is a
 *   duration. Treating one as the other puts every Kick link's expiry in 1970 or in the far future.
 *
 * ### The email is deliberately dropped
 *
 * `public/v1/users` returns the account's `email` whether or not anything asked for it. Nothing in
 * this project has a use for it, {@link ProviderIdentity} has nowhere to put it, and a field that is
 * read and then stored "in case" is how a site ends up holding personal data it never needed. It is
 * not parsed.
 *
 * ### One thing taken on documentation rather than measured
 *
 * Kick documents the token response as carrying `scope` but does not say whether it is the
 * space-delimited string RFC 6749 requires or, as Twitch does, a JSON array. Introspection returns a
 * string, so a string is the assumption. If an exchange ever fails with `"response" body "scope"
 * property must be a string`, the fix is one line — `quirks: { spaceDelimitedScope: true }` below —
 * and that error message is deliberately the one `./oauth2.ts` lets through for exactly this case.
 */

import { z } from 'zod';
import { KICK_CLIENT_ID, KICK_CLIENT_SECRET } from '$app/env/private';
import type { ProviderIdentity } from '../accounts.js';
import {
	OAuth2Failure,
	authorizationUrl,
	codeVerifier,
	exchangeCode,
	refreshTokens
} from './oauth2.js';
import type { Callback, OAuth2App } from './oauth2.js';
import { SignInFailure } from './sign-in-provider.js';
import type { Authorization, Grant, SignInProvider } from './sign-in-provider.js';

/** Where the visitor approves. */
const AUTHORIZATION_ENDPOINT = 'https://id.kick.com/oauth/authorize';

/** Where the code is exchanged. */
const TOKEN_ENDPOINT = 'https://id.kick.com/oauth/token';

/** Whose token is this, and what may it do. */
const INTROSPECT = 'https://id.kick.com/oauth/token/introspect';

/** Where the name and the avatar come from. */
const USERS = 'https://api.kick.com/public/v1/users';

/**
 * `user:read`, and nothing else.
 *
 * The minimum that makes `public/v1/users` answer, which is what identity needs. `channel:read`
 * would be required to read the creator's channel and live state, and goes on this list when a
 * reader here actually does that — not before, because every scope is one the creator has to approve
 * and this application has to be trusted with.
 */
const SCOPES: readonly string[] = ['user:read'];

/** How long either request may take before it is given up on. */
const TIMEOUT_MS = 10_000;

/** A Kick user id, as a string: digits, and Kick's are well under this length. */
const USER_ID = /^\d{1,20}$/;

/**
 * What introspection answers.
 *
 * Everything under `data`, which is Kick's envelope on every endpoint. `active` is the only field
 * that is strictly required to be useful — the rest is checked where it is read.
 */
const introspectionSchema = z
	.object({
		data: z
			.object({
				active: z.boolean(),
				client_id: z.string().nullish(),
				token_type: z.string().nullish(),
				scope: z.string().nullish(),
				exp: z.number().nullish()
			})
			.loose()
			.nullish()
	})
	.loose();

/**
 * What `public/v1/users` is read for.
 *
 * `email` is absent on purpose — see the note at the top. `user_id` is a **number** here, unlike
 * Twitch's string id, and is converted rather than trusted to arrive as a string.
 */
const usersSchema = z
	.object({
		data: z
			.array(
				z
					.object({
						user_id: z.number().optional(),
						name: z.string().nullish(),
						profile_picture: z.string().nullish()
					})
					.loose()
			)
			.nullish()
	})
	.loose();

/** A validated token, and what it is good for. */
interface Introspection {
	readonly scopes: readonly string[];

	/** Unix seconds, or null when Kick did not say. */
	readonly expiresAt: number | null;
}

/** The Kick sign-in provider. */
export function kickSignIn(): SignInProvider {
	return {
		kind: 'kick',
		label: 'Kick',

		usable: () => KICK_CLIENT_ID !== undefined && KICK_CLIENT_SECRET !== undefined,

		authorize: async (state, redirectUri): Promise<Authorization> => {
			// Required, not optional: Kick rejects an authorization request without a challenge, and
			// `S256` is the only method it accepts. `./oauth2.ts` sends the challenge and keeps the
			// verifier out of the URL.
			const verifier = codeVerifier();

			return {
				url: await authorizationUrl(app(), { state, redirectUri, scopes: SCOPES, verifier }),
				verifier
			};
		},

		identify: async (callback) => (await exchange(callback)).identity,

		grant: async (callback) => exchange(callback),

		refresh: async (refreshToken) => {
			try {
				return await refreshTokens(app(), refreshToken);
			} catch (cause) {
				if (cause instanceof SignInFailure) throw cause;

				throw new SignInFailure(
					cause instanceof OAuth2Failure && cause.kind === 'refused'
						? 'Kick would not renew that link. It has to be connected again.'
						: 'Kick could not be reached. Try again in a moment.'
				);
			}
		}
	};
}

/**
 * Checking a personal access token somebody pasted.
 *
 * Exported separately because it is a different act from signing in: no redirect, no state, no code
 * — just "is this a working Kick token for this application, and whose is it".
 */
export async function verifyKickToken(token: string): Promise<Grant> {
	const trimmed = token.trim();

	if (trimmed === '') throw new SignInFailure('That token was empty.');

	const introspection = await introspect(trimmed);

	return {
		identity: await decorate(trimmed),
		accessToken: trimmed,

		// A pasted token has no refresh token by definition — nobody can mint one from it — so this
		// link lapses and has to be pasted again.
		refreshToken: null,
		expiresAt: introspection.expiresAt,
		scopes: introspection.scopes
	};
}

/**
 * This application's OAuth configuration.
 *
 * Built per call rather than at module load so that importing this module reads no environment, and
 * an unconfigured install fails where somebody tries to use it with a sentence about the site.
 */
function app(): OAuth2App {
	if (KICK_CLIENT_ID === undefined || KICK_CLIENT_SECRET === undefined) {
		throw new SignInFailure('Signing in with Kick has not been set up on this site.');
	}

	return {
		clientId: KICK_CLIENT_ID,
		clientSecret: KICK_CLIENT_SECRET,
		authorizationEndpoint: AUTHORIZATION_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,

		// Kick documents the secret as a form parameter and does not offer a Basic header, which also
		// avoids the re-encoding hazard recorded on `ClientAuth`.
		clientAuth: 'body'
	};
}

/**
 * The code, exchanged and introspected.
 *
 * One function for both `identify` and `grant`, so the identity a sign-in produces and the one a
 * link stores cannot drift — and so the code is exchanged exactly once either way, which matters
 * because a second attempt with the same code is rejected.
 */
async function exchange(callback: Callback): Promise<Grant> {
	let tokens;

	try {
		tokens = await exchangeCode(app(), callback);
	} catch (cause) {
		if (cause instanceof SignInFailure) throw cause;

		// Never the response body: a failed token exchange can echo the request it rejected, and the
		// request carries the client secret.
		throw new SignInFailure(
			cause instanceof OAuth2Failure && cause.kind === 'refused'
				? 'Kick rejected the sign-in. Starting again usually fixes it.'
				: 'Kick could not be reached. Try again in a moment.'
		);
	}

	const introspection = await introspect(tokens.accessToken);

	return {
		identity: await decorate(tokens.accessToken),
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,

		// Introspection's absolute `exp` in preference to the exchange's duration: it is the value
		// Kick itself will enforce, and the two are the same answer only if the clocks agree.
		expiresAt: introspection.expiresAt ?? tokens.expiresAt,
		scopes: introspection.scopes.length > 0 ? introspection.scopes : tokens.scopes
	};
}

/**
 * Whether this token is live, ours, and a person's.
 *
 * Three refusals, each for its own reason — see the note at the top on `token_type` and on the
 * application check.
 */
async function introspect(token: string): Promise<Introspection> {
	const response = await fetch(INTROSPECT, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	if (response === null) {
		throw new SignInFailure('Kick could not be reached. Try again in a moment.');
	}

	if (response.status === 401) {
		throw new SignInFailure('Kick did not accept that token. It may have expired.');
	}

	// Never the body paired with the status: this request carried a credential, and an error from an
	// API gateway can quote the request that produced it.
	if (!response.ok) {
		throw new SignInFailure('Kick did not say whose token that is. Try again in a moment.');
	}

	const parsed = introspectionSchema.safeParse(await response.json().catch(() => null));
	const data = parsed.success ? parsed.data.data : undefined;

	if (data === undefined || data === null) {
		throw new SignInFailure('Kick did not say whose token that is.');
	}

	if (!data.active) {
		throw new SignInFailure('Kick did not accept that token. It may have expired.');
	}

	// An app token authenticates the application rather than a person, so it cannot answer whose
	// account this is. Storing one as somebody's link would attach a site-wide credential to a
	// personal connection.
	if (typeof data.token_type === 'string' && data.token_type !== 'user') {
		throw new SignInFailure('That token belongs to an application rather than an account.');
	}

	// Only when Kick actually names an application. Its own documentation shows this field empty in
	// the example response, so a strict check would refuse every token on an install where Kick does
	// not populate it — which would be a worse failure than the one it guards against.
	if (
		KICK_CLIENT_ID !== undefined &&
		typeof data.client_id === 'string' &&
		data.client_id !== '' &&
		data.client_id !== KICK_CLIENT_ID
	) {
		throw new SignInFailure('That token belongs to a different application.');
	}

	return {
		scopes: typeof data.scope === 'string' ? data.scope.split(' ').filter((s) => s !== '') : [],

		// An absolute timestamp, not a duration. Zero or a past value is reported as null rather than
		// as an expiry in 1970, which would make every such link render as permanently lapsed.
		expiresAt: typeof data.exp === 'number' && data.exp > 0 ? Math.floor(data.exp) : null
	};
}

/**
 * Who this is, with a name and an avatar where they can be had.
 *
 * Unlike Twitch, this call is **not** optional: introspection tells us the token is good but never
 * says whose it is, so without `public/v1/users` there is no `providerUserId` to key an identity on.
 * A failure here therefore has to fail the sign-in.
 */
async function decorate(token: string): Promise<ProviderIdentity> {
	const response = await fetch(USERS, {
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	if (response === null) {
		throw new SignInFailure('Kick could not be reached. Try again in a moment.');
	}

	if (!response.ok) {
		throw new SignInFailure('Kick did not say who that token belongs to.');
	}

	const parsed = usersSchema.safeParse(await response.json().catch(() => null));
	const entry = parsed.success ? parsed.data.data?.[0] : undefined;
	const userId = entry?.user_id;

	// Checked rather than taken: it becomes a database key and is compared against rows. Kick sends a
	// number, so this is also where it becomes the string the rest of the project uses.
	if (userId === undefined || !Number.isSafeInteger(userId) || !USER_ID.test(String(userId))) {
		throw new SignInFailure('Kick did not say who that token belongs to.');
	}

	const name = nonEmpty(entry?.name);
	const avatarUrl = httpsOnly(entry?.profile_picture);

	return {
		provider: 'kick',
		providerUserId: String(userId),
		...(name === null ? {} : { name }),
		...(avatarUrl === null ? {} : { avatarUrl })
	};
}

/** A string that is actually a string with something in it. */
function nonEmpty(value: string | null | undefined): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * An `https` url, or null.
 *
 * Checked because it ends up in an `<img src>` on the admin, which is a request every visitor to
 * that page makes to whatever host it names.
 */
function httpsOnly(value: string | null | undefined): string | null {
	const url = nonEmpty(value);

	return url?.startsWith('https://') === true ? url : null;
}
