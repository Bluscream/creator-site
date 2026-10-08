/**
 * Signing in with Discord.
 *
 * A port of `www/lib/Auth.php`, which built the authorize URL and the token exchange by hand. What
 * is kept is the set of decisions that file made and justified; what is dropped is the plumbing,
 * which `./oauth2.ts` does.
 *
 * ### The secret goes in the body, not an HTTP Basic header
 *
 * Discord accepts either — its documentation says "all calls to the OAuth2 endpoints require either
 * HTTP Basic authentication or `client_id` and `client_secret` supplied in the form data body" — and
 * the body is the safe one, for a specific reason.
 *
 * RFC 6749 Appendix B requires the Basic credentials to be form-urlencoded *before* base64, with the
 * unreserved set narrowed to letters and digits — so `-`, `_`, `.` and `~` all become percent
 * escapes. `oauth4webapi` does that correctly; `arctic` did not, and sent the raw bytes. Discord
 * describes Basic as plain base64 of `client_id:client_secret` and does not document decoding the
 * value, and a Discord client secret is drawn from an alphabet that routinely contains `-` and `_`.
 *
 * So the two spellings are not reliably interchangeable here, and taking the spec-correct one on
 * trust would have meant a 401 that reads like a wrong secret. The form body sidesteps it entirely:
 * nothing re-encodes the credential on the way out. `./oauth2.ts` still supports `basic` for the
 * platforms that require it, with the hazard recorded there.
 *
 * ### `identify` and nothing else
 *
 * The one scope requested. Not `guilds`, not `email`, not `guilds.members.read`. The site needs to
 * know who signed in and nothing more, and a scope requested is a scope the visitor has to approve
 * and the application has to be trusted with. The access token is used exactly once, to read
 * `/users/@me`, and then dropped — it is never stored, so there is no refresh flow and nothing to
 * leak later.
 *
 * ### The id is the identity, never the name
 *
 * A Discord username can be changed by its owner and then registered by somebody else. A snowflake
 * cannot. So the `identities` row is keyed by the snowflake and the display name is treated as
 * decoration that may change at any sign-in.
 */

import { z } from 'zod';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } from '$app/env/private';
import type { ProviderIdentity } from '../accounts.js';
import { OAuth2Failure, authorizationUrl, codeVerifier, exchangeCode } from './oauth2.js';
import type { Callback, OAuth2App } from './oauth2.js';
import { SignInFailure } from './sign-in-provider.js';
import type { Authorization, SignInProvider } from './sign-in-provider.js';

/** Where the visitor approves. */
const AUTHORIZATION_ENDPOINT = 'https://discord.com/oauth2/authorize';

/** Where the code is exchanged. */
const TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';

/** Where the current user's own account is read from. */
const IDENTITY = 'https://discord.com/api/v10/users/@me';

/** Only `identify`. See the note at the top. */
const SCOPES = ['identify'] as const;

/** How long the identity request may take before it is given up on. */
const TIMEOUT_MS = 10_000;

/**
 * A Discord snowflake.
 *
 * Validated because it becomes a database key and is interpolated into an avatar URL. Discord's own
 * ids are 17 to 20 digits; anything else is not an answer to "who signed in".
 */
const SNOWFLAKE = /^\d{17,20}$/;

/** An avatar hash, as Discord writes them. `a_` prefixes an animated one. */
const AVATAR_HASH = /^[a-f0-9_]{1,64}$/;

/** What `/users/@me` is read for. Everything but `id` is optional and decorative. */
const accountSchema = z
	.object({
		id: z.string(),
		global_name: z.string().nullish(),
		username: z.string().nullish(),
		avatar: z.string().nullish()
	})
	.loose();

/** The Discord sign-in provider. */
export function discordSignIn(): SignInProvider {
	return {
		kind: 'discord',
		label: 'Discord',

		usable: () => DISCORD_CLIENT_ID !== undefined && DISCORD_CLIENT_SECRET !== undefined,

		authorize: async (state, redirectUri): Promise<Authorization> => {
			// PKCE, although this is a confidential client with a secret and Discord treats it as
			// optional. `state` already binds the callback to this browser; PKCE binds the *code* to
			// this exchange, so a code that leaks — a referrer, a shared screen, a proxy log — cannot be
			// redeemed by whoever picked it up. `arctic` passed null here and Discord accepted it; there
			// was never a reason not to.
			const verifier = codeVerifier();

			return {
				url: await authorizationUrl(app(), { state, redirectUri, scopes: SCOPES, verifier }),
				verifier
			};
		},

		identify: async (callback) => account(await exchange(callback))
	};
}

/**
 * This application's OAuth configuration.
 *
 * Built per call rather than once at module load so that importing this module reads no environment
 * and an unconfigured install fails at the point somebody tries to use it, with a sentence about the
 * site rather than a type error. Constructing it is assigning five strings.
 */
function app(): OAuth2App {
	if (DISCORD_CLIENT_ID === undefined || DISCORD_CLIENT_SECRET === undefined) {
		throw new SignInFailure('Signing in with Discord has not been set up on this site.');
	}

	return {
		clientId: DISCORD_CLIENT_ID,
		clientSecret: DISCORD_CLIENT_SECRET,
		authorizationEndpoint: AUTHORIZATION_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,
		// Not Basic. See the note at the top — this is about the credential surviving the trip, not
		// about preference.
		clientAuth: 'body'
	};
}

/**
 * Swaps the authorization code for an access token.
 *
 * The error message never includes the provider's response. A failed token exchange can echo the
 * request it rejected, and the request carries the client secret — which is how a credential ends up
 * in a log or on a visitor's screen.
 */
async function exchange(callback: Callback): Promise<string> {
	try {
		return (await exchangeCode(app(), callback)).accessToken;
	} catch (cause) {
		if (cause instanceof SignInFailure) throw cause;

		// `refused` means Discord answered and said no — an expired code, a reused one, a redirect
		// that does not match what the application registered. Anything else is the network.
		throw new SignInFailure(
			cause instanceof OAuth2Failure && cause.kind === 'refused'
				? 'Discord rejected the sign-in. Starting again usually fixes it.'
				: 'Discord could not be reached. Try again in a moment.'
		);
	}
}

/** Reads who the token belongs to. */
async function account(token: string): Promise<ProviderIdentity> {
	const response = await fetch(IDENTITY, {
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	// Never the body, and never the status paired with it: this request carried a bearer token, and
	// an error response from an API gateway can quote the request that produced it.
	if (response?.ok !== true) {
		throw new SignInFailure('Discord did not say who signed in. Try again in a moment.');
	}

	const parsed = accountSchema.safeParse(await response.json().catch(() => null));

	if (!parsed.success || !SNOWFLAKE.test(parsed.data.id)) {
		throw new SignInFailure('Discord did not say who signed in.');
	}

	const { id, global_name: display, username, avatar } = parsed.data;
	const name = nonEmpty(display) ?? nonEmpty(username);
	const avatarUrl = avatarOf(id, avatar);

	return {
		provider: 'discord',
		providerUserId: id,
		...(name === null ? {} : { name }),
		...(avatarUrl === null ? {} : { avatarUrl })
	};
}

/** A string that is actually a string with something in it. */
function nonEmpty(value: string | null | undefined): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The CDN URL for an avatar, or null.
 *
 * The hash is checked against {@link AVATAR_HASH} before it is interpolated. It arrives from an
 * external response, and a path segment taken on trust is how a URL ends up pointing somewhere else
 * — which in an `<img src>` is a request every visitor to the admin makes to somebody else's server.
 */
function avatarOf(id: string, hash: string | null | undefined): string | null {
	const value = nonEmpty(hash);

	if (value === null || !AVATAR_HASH.test(value)) return null;

	return `https://cdn.discordapp.com/avatars/${id}/${value}.png?size=64`;
}
