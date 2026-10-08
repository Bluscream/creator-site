/**
 * Signing in with Twitch, and linking a Twitch account.
 *
 * The second provider behind `./sign-in-provider.ts`, and the first one whose token is worth
 * keeping — so it is also the first to implement `grant`. Discord's link is a handle and an avatar;
 * a Twitch link is a credential the post, live and socials capabilities can use.
 *
 * ### Why `/oauth2/validate` is the identity call
 *
 * Twitch publishes an endpoint whose entire job is "whose token is this, and what may it do":
 * `GET https://id.twitch.tv/oauth2/validate` with an `OAuth <token>` header returns the client id,
 * the login, the user id, the granted scopes and the seconds remaining. That is exactly what both
 * halves of this file need, and it is the only call that works for **both** an OAuth code exchange
 * and a token somebody pasted — one request, one parser, one set of failure messages, rather than a
 * second path that could disagree with the first.
 *
 * It also answers a question `helix/users` cannot: **which application the token belongs to**. A
 * token minted for somebody else's client id is a perfectly valid Twitch token that this site must
 * refuse, because its scopes and its revocation are not ours to reason about.
 *
 * `helix/users` is still called, for the display name and the avatar, and a failure there is not
 * fatal: knowing who signed in is the requirement, and decoration is decoration.
 *
 * ### `OAuth`, not `Bearer`
 *
 * `/oauth2/validate` wants `Authorization: OAuth <token>`; Helix wants `Authorization: Bearer
 * <token>`. The same token, two spellings, and the wrong one is a 401 that reads like a bad
 * credential. It has its own constant here so neither is a literal at a call site.
 *
 * ### Two things Twitch does its own way
 *
 * Both are declared to `./oauth2.ts` rather than discovered, and both were measured:
 *
 * - The client secret goes in the **form body**, not an HTTP Basic header, which is the opposite of
 *   Discord.
 * - The token response carries `scope` as a JSON **array**. RFC 6749 §5.1 requires a space-delimited
 *   string, and a specification-exact client refuses the response outright — so the quirk is declared
 *   and the array is joined before the response is read.
 */

import { z } from 'zod';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from '$app/env/private';
import type { ProviderIdentity } from '../accounts.js';
import { OAuth2Failure, authorizationUrl, exchangeCode, refreshTokens } from './oauth2.js';
import type { Callback, OAuth2App } from './oauth2.js';
import { SignInFailure } from './sign-in-provider.js';
import type { Authorization, Grant, SignInProvider } from './sign-in-provider.js';

/** Where the visitor approves. */
const AUTHORIZATION_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize';

/** Where the code is exchanged. */
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';

/** Whose token is this, and what may it do. */
const VALIDATE = 'https://id.twitch.tv/oauth2/validate';

/** Where the display name and the avatar come from. */
const USERS = 'https://api.twitch.tv/helix/users';

/**
 * Nothing.
 *
 * Identity needs no scope at all — `/oauth2/validate` and `helix/users` both answer for the
 * creator's own account on a bare user token. Every scope requested is one the creator has to
 * approve and this application has to be trusted with, so the list stays empty until a capability
 * here actually needs one. Chat through EventSub would add `user:read:chat`; it is not wired up, so
 * it is not asked for.
 */
const SCOPES: readonly string[] = [];

/** How long either request may take before it is given up on. */
const TIMEOUT_MS = 10_000;

/** A Twitch user id: digits, and Twitch's are well under this length. */
const USER_ID = /^\d{1,20}$/;

/** A Twitch login: 3–25 of these, which is Twitch's own rule. */
const LOGIN = /^[A-Za-z0-9_]{3,25}$/;

/** What `/oauth2/validate` answers. `expires_in` is 0 for a token that does not expire. */
const validationSchema = z
	.object({
		client_id: z.string(),
		login: z.string().nullish(),
		user_id: z.string(),
		scopes: z.array(z.string()).nullish(),
		expires_in: z.number().nullish()
	})
	.loose();

/** What `helix/users` is read for. Everything but the id is decoration. */
const usersSchema = z
	.object({
		data: z
			.array(
				z
					.object({
						id: z.string().optional(),
						display_name: z.string().nullish(),
						profile_image_url: z.string().nullish()
					})
					.loose()
			)
			.nullish()
	})
	.loose();

/** A validated token, and what it is good for. */
interface Validation {
	readonly userId: string;
	readonly login: string | null;
	readonly scopes: readonly string[];

	/** Unix seconds, or null for a token Twitch does not expire. */
	readonly expiresAt: number | null;
}

/** The Twitch sign-in provider. */
export function twitchSignIn(): SignInProvider {
	return {
		kind: 'twitch',
		label: 'Twitch',

		usable: () => TWITCH_CLIENT_ID !== undefined && TWITCH_CLIENT_SECRET !== undefined,

		authorize: async (state, redirectUri): Promise<Authorization> => ({
			// Null verifier: Twitch is a confidential client with a secret and does not require a code
			// challenge. The `state` parameter is what protects this flow, and `./flow.ts` is what
			// checks it against the cookie.
			url: await authorizationUrl(app(), { state, redirectUri, scopes: SCOPES }),
			verifier: null
		}),

		identify: async (callback) => (await exchange(callback)).identity,

		grant: async (callback) => exchange(callback),

		refresh: async (refreshToken) => {
			try {
				return await refreshTokens(app(), refreshToken);
			} catch (cause) {
				if (cause instanceof SignInFailure) throw cause;

				// A refused refresh is the end of the link: the creator revoked it, or changed their
				// password, or it simply aged out. Saying so is what lets the account page ask for a
				// re-link instead of showing a connection that cannot do anything.
				throw new SignInFailure(
					cause instanceof OAuth2Failure && cause.kind === 'refused'
						? 'Twitch would not renew that link. It has to be connected again.'
						: 'Twitch could not be reached. Try again in a moment.'
				);
			}
		}
	};
}

/**
 * Checking a personal access token somebody pasted.
 *
 * Exported separately from the sign-in provider because it is a different act: no redirect, no
 * state, no code — just "is this a working Twitch token for this application, and whose is it".
 * `./platform.ts` is what pairs the two.
 */
export async function verifyTwitchToken(token: string): Promise<Grant> {
	const trimmed = token.trim();

	if (trimmed === '') throw new SignInFailure('That token was empty.');

	const validation = await validate(trimmed);

	return {
		identity: await decorate(validation, trimmed),
		accessToken: trimmed,

		// A pasted token has no refresh token by definition — nobody can mint one from it — so this
		// link lapses and has to be pasted again. That is the cost of the method, and
		// `Connection.refreshable` is how the account page says so.
		refreshToken: null,
		expiresAt: validation.expiresAt,
		scopes: validation.scopes
	};
}

/**
 * This application's OAuth configuration.
 *
 * Built per call rather than once at module load so that importing this module reads no environment
 * and an unconfigured install fails where somebody tries to use it, with a sentence about the site
 * rather than a type error.
 */
function app(): OAuth2App {
	if (TWITCH_CLIENT_ID === undefined || TWITCH_CLIENT_SECRET === undefined) {
		throw new SignInFailure('Signing in with Twitch has not been set up on this site.');
	}

	return {
		clientId: TWITCH_CLIENT_ID,
		clientSecret: TWITCH_CLIENT_SECRET,
		authorizationEndpoint: AUTHORIZATION_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,

		// Not Basic. See the note at the top.
		clientAuth: 'body',
		quirks: { spaceDelimitedScope: true }
	};
}

/**
 * The code, exchanged and validated.
 *
 * One function for both `identify` and `grant`, so the identity a sign-in produces and the identity
 * a link stores cannot drift apart — and so the code is exchanged exactly once either way, which
 * matters because a second attempt with the same code is rejected.
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
				? 'Twitch rejected the sign-in. Starting again usually fixes it.'
				: 'Twitch could not be reached. Try again in a moment.'
		);
	}

	const validation = await validate(tokens.accessToken);

	return {
		identity: await decorate(validation, tokens.accessToken),
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,

		// `/oauth2/validate`'s answer, not the token response's. It is the same token either way, and
		// validate is the endpoint that distinguishes "does not expire" from "expires in zero
		// seconds" — a distinction the grant response does not make.
		expiresAt: validation.expiresAt,
		scopes: validation.scopes
	};
}

/**
 * Whose token this is, and whether it is ours.
 *
 * A token minted for a different application is refused. It is a valid Twitch token, and that is
 * precisely the problem: its scopes were granted to somebody else's client id, and this site can
 * neither reason about them nor revoke it.
 */
async function validate(token: string): Promise<Validation> {
	const response = await fetch(VALIDATE, {
		headers: { authorization: `OAuth ${token}`, accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	if (response === null) {
		throw new SignInFailure('Twitch could not be reached. Try again in a moment.');
	}

	if (response.status === 401) {
		throw new SignInFailure('Twitch did not accept that token. It may have expired.');
	}

	// Never the body paired with the status: this request carried a credential, and an error from an
	// API gateway can quote the request that produced it.
	if (!response.ok) {
		throw new SignInFailure('Twitch did not say whose token that is. Try again in a moment.');
	}

	const parsed = validationSchema.safeParse(await response.json().catch(() => null));

	if (!parsed.success || !USER_ID.test(parsed.data.user_id)) {
		throw new SignInFailure('Twitch did not say whose token that is.');
	}

	if (TWITCH_CLIENT_ID !== undefined && parsed.data.client_id !== TWITCH_CLIENT_ID) {
		throw new SignInFailure('That token belongs to a different application.');
	}

	const login = parsed.data.login ?? '';
	const expiresIn = parsed.data.expires_in ?? 0;

	return {
		userId: parsed.data.user_id,
		login: LOGIN.test(login) ? login : null,
		scopes: parsed.data.scopes ?? [],

		// Zero means "does not expire", which Twitch uses for some token types. Null rather than a
		// timestamp in 1970, which would make every link look lapsed.
		expiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : null
	};
}

/**
 * The identity, with a display name and an avatar where they can be had.
 *
 * A failure here is not fatal. The requirement is knowing *who*, which `/oauth2/validate` has
 * already answered; the display name and the avatar are decoration, and refusing a sign-in because
 * a decorative request timed out would be the wrong trade.
 */
async function decorate(validation: Validation, token: string): Promise<ProviderIdentity> {
	const fallback: ProviderIdentity = {
		provider: 'twitch',
		providerUserId: validation.userId,
		...(validation.login === null ? {} : { name: validation.login })
	};

	if (TWITCH_CLIENT_ID === undefined) return fallback;

	const response = await fetch(USERS, {
		// `Bearer` here and `OAuth` at `/oauth2/validate`: the same token, two spellings, and the
		// wrong one is a 401 that reads like a bad credential.
		headers: {
			authorization: `Bearer ${token}`,
			'client-id': TWITCH_CLIENT_ID,
			accept: 'application/json'
		},
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	if (response?.ok !== true) return fallback;

	const parsed = usersSchema.safeParse(await response.json().catch(() => null));
	const entry = parsed.success ? parsed.data.data?.[0] : undefined;

	if (entry === undefined) return fallback;

	const name = nonEmpty(entry.display_name) ?? validation.login;
	const avatarUrl = httpsOnly(entry.profile_image_url);

	return {
		provider: 'twitch',
		providerUserId: validation.userId,
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
 * that page makes to whatever host it names. Twitch serves its avatars from its own CDN; anything
 * else arriving in this field is not something to render on trust.
 */
function httpsOnly(value: string | null | undefined): string | null {
	const url = nonEmpty(value);

	return url?.startsWith('https://') === true ? url : null;
}
