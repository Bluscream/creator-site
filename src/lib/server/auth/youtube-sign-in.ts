/**
 * Linking a YouTube channel.
 *
 * The first platform that is **not** a way of signing in, which is what makes it worth having: it
 * is the common case rather than the exception. A creator links YouTube so the site knows their
 * channel, not so they can log in with it — and making it a sign-in provider would mean asking for
 * a YouTube scope just to authenticate, and failing for anybody whose Google account has no channel.
 *
 * `./platform.ts` always said capabilities and methods were independent lists. This is the platform
 * that proves it, and finding that the auth routes had collapsed them is why `linkProvider` exists.
 *
 * ### Google's endpoints, YouTube's identity
 *
 * The OAuth is Google's. The identity is deliberately **not**: it is the YouTube channel id, from
 * `youtube/v3/channels?mine=true`, rather than the Google account's `sub`. The platform here is
 * called `youtube`, the registry in `src/lib/platforms.ts` keys `youtube` to youtube.com hosts, and
 * a channel id is what produces a public URL worth putting on a page. A Google `sub` would be an
 * opaque number this site could do nothing with.
 *
 * The consequence is stated rather than hidden: a Google account with no channel cannot be linked,
 * and gets told so.
 *
 * ### `access_type=offline`, or there is no refresh token at all
 *
 * Google issues a refresh token **only** when the authorization request asks for one. Without it the
 * access token lasts an hour and the link cannot be renewed — and nothing says so at link time. The
 * link would simply stop working an hour later, which is the failure `auth/token.ts` exists to
 * prevent and would have been reintroduced here by omission.
 *
 * `prompt=consent` is deliberately *not* sent with it. Google returns a refresh token on the first
 * authorization and not on later ones, so forcing the consent screen every time is the documented
 * way to always get one — at the cost of re-prompting somebody who is already linked. Re-linking is
 * rare and already an explicit action, so the quieter flow wins; if a re-link ever comes back
 * without a refresh token, this is the line to change.
 *
 * ### No paste-a-token method, and no client-id check
 *
 * Google publishes no tool that mints a user token for your own application, so there is nothing an
 * operator could honestly paste — as with Kick. Which also removes the reason for a `tokeninfo`
 * call: the application check that Twitch and Kick perform exists to vet a token that arrived from
 * somewhere else, and every token here came from this site's own exchange. Calling `tokeninfo`
 * anyway would mean a second round trip, and Google's form of it takes the token as a **query
 * parameter**, which is a credential in a URL.
 */

import { z } from 'zod';
import { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } from '$app/env/private';
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

/** Where the visitor approves. Google's, not YouTube's. */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Where the code is exchanged. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The creator's own channel. `mine=true` needs no id and works for exactly one channel. */
const CHANNELS = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';

/**
 * Read-only, and only YouTube.
 *
 * Not `youtube` (which can delete videos), not `youtube.force-ssl` (which can post comments as the
 * creator), and nothing from the rest of Google. The most destructive thing this scope permits is
 * reading, which is all the site will ever do with it.
 */
const SCOPES: readonly string[] = ['https://www.googleapis.com/auth/youtube.readonly'];

/** Required for a refresh token. See the note at the top. */
const EXTRA: Readonly<Record<string, string>> = { access_type: 'offline' };

/** How long the channel request may take before it is given up on. */
const TIMEOUT_MS = 10_000;

/** A YouTube channel id: `UC` and 22 more of the base64url alphabet. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** What `youtube/v3/channels` is read for. */
const channelsSchema = z
	.object({
		items: z
			.array(
				z
					.object({
						id: z.string().optional(),
						snippet: z
							.object({
								title: z.string().nullish(),
								customUrl: z.string().nullish(),
								thumbnails: z
									.object({
										default: z.object({ url: z.string().nullish() }).loose().nullish(),
										medium: z.object({ url: z.string().nullish() }).loose().nullish()
									})
									.loose()
									.nullish()
							})
							.loose()
							.nullish()
					})
					.loose()
			)
			.nullish()
	})
	.loose();

/** The YouTube link provider. */
export function youtubeSignIn(): SignInProvider {
	return {
		kind: 'youtube',
		label: 'YouTube',

		usable: () => YOUTUBE_CLIENT_ID !== undefined && YOUTUBE_CLIENT_SECRET !== undefined,

		authorize: async (state, redirectUri): Promise<Authorization> => {
			// Google's discovery document advertises `code_challenge_methods_supported: ["plain",
			// "S256"]`, so PKCE is used: it binds the code to this exchange, which `state` alone does
			// not.
			const verifier = codeVerifier();

			return {
				url: await authorizationUrl(app(), {
					state,
					redirectUri,
					scopes: SCOPES,
					verifier,
					extra: EXTRA
				}),
				verifier
			};
		},

		// Present because the seam requires it, and reached only through a `connect` flow — this
		// platform does not declare the `sign-in` capability, and `flow.ts` refuses a sign-in intent
		// for one that does not. Returning the channel rather than throwing keeps the two paths
		// identical, so the refusal stays in the one place that owns it.
		identify: async (callback) => (await exchange(callback)).identity,

		grant: async (callback) => exchange(callback),

		refresh: async (refreshToken) => {
			try {
				return await refreshTokens(app(), refreshToken);
			} catch (cause) {
				if (cause instanceof SignInFailure) throw cause;

				throw new SignInFailure(
					cause instanceof OAuth2Failure && cause.kind === 'refused'
						? 'YouTube would not renew that link. It has to be connected again.'
						: 'YouTube could not be reached. Try again in a moment.'
				);
			}
		}
	};
}

/**
 * This application's OAuth configuration.
 *
 * Built per call rather than at module load so that importing this module reads no environment.
 */
function app(): OAuth2App {
	if (YOUTUBE_CLIENT_ID === undefined || YOUTUBE_CLIENT_SECRET === undefined) {
		throw new SignInFailure('Linking YouTube has not been set up on this site.');
	}

	return {
		clientId: YOUTUBE_CLIENT_ID,
		clientSecret: YOUTUBE_CLIENT_SECRET,
		authorizationEndpoint: AUTHORIZATION_ENDPOINT,
		tokenEndpoint: TOKEN_ENDPOINT,

		// Google documents the secret as a form parameter at the token endpoint.
		clientAuth: 'body'
	};
}

/** The code, exchanged, and the channel it belongs to. */
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
				? 'YouTube rejected the link. Starting again usually fixes it.'
				: 'YouTube could not be reached. Try again in a moment.'
		);
	}

	return {
		identity: await channel(tokens.accessToken),
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
		scopes: tokens.scopes
	};
}

/**
 * The creator's channel.
 *
 * Not optional decoration, unlike Twitch's `helix/users`: the token exchange says nothing about who
 * this is, so without this call there is no id to key a connection on.
 */
async function channel(token: string): Promise<ProviderIdentity> {
	const response = await fetch(CHANNELS, {
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => null);

	if (response === null) {
		throw new SignInFailure('YouTube could not be reached. Try again in a moment.');
	}

	if (!response.ok) {
		throw new SignInFailure('YouTube did not say which channel that is.');
	}

	const parsed = channelsSchema.safeParse(await response.json().catch(() => null));
	const entry = parsed.success ? parsed.data.items?.[0] : undefined;

	// An empty `items` is Google's answer for a Google account that has no YouTube channel, not an
	// error. It is the one honest limitation of keying this platform on a channel rather than on the
	// Google account, so it gets a sentence a person can act on.
	if (entry === undefined) {
		throw new SignInFailure('That Google account has no YouTube channel to link.');
	}

	// Checked rather than taken: it becomes a database key and is compared against rows.
	if (entry.id === undefined || !CHANNEL_ID.test(entry.id)) {
		throw new SignInFailure('YouTube did not say which channel that is.');
	}

	// The handle in preference to the title, because `@someone` is what a viewer would recognise and
	// what the channel's own URL uses. The title is the fallback.
	const name = nonEmpty(entry.snippet?.customUrl) ?? nonEmpty(entry.snippet?.title);
	const thumbnails = entry.snippet?.thumbnails;
	const avatarUrl = httpsOnly(thumbnails?.medium?.url) ?? httpsOnly(thumbnails?.default?.url);

	return {
		provider: 'youtube',
		providerUserId: entry.id,
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
