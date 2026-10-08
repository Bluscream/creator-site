/**
 * Twitch, as a platform an account can be linked to.
 *
 * The first platform that offers both methods, and therefore the one that makes `./platform.ts`
 * worth having: OAuth where the secret never passes through a form, and a pasted token for the
 * operator who cannot register an application — a self-hosted install behind a domain Twitch will
 * not accept a redirect for, which is a real situation rather than a hypothetical one.
 *
 * ### Why `posts` and `live` are claimed when the reader already works without a link
 *
 * `twitch-source.ts` reads VODs and clips on an **app** token, which needs no creator involvement
 * at all, so Twitch posts work on a bare install. The claim here is still honest: `credentialsFor`
 * resolves a linked account before the environment, so a link is what makes the reader work on an
 * install whose operator never touched an environment variable — which is the whole direction of
 * this product. The capability is "a link here can serve this", not "this only works with a link".
 *
 * ### Why `chat` is not claimed
 *
 * Reading Twitch chat means EventSub and a `user:read:chat` scope, and nothing in this project reads
 * it yet — chat comes through Synchra. Claiming it would put a capability on the account page that
 * leads nowhere, and would mean asking the creator to approve a scope nothing uses. It goes on the
 * list when the reader does.
 */

import { twitchSignIn, verifyTwitchToken } from './twitch-sign-in.js';
import type { AccountPlatform, TokenLink } from './platform.js';

/**
 * Where to get a token by hand, for somebody using the paste field.
 *
 * Names the CLI rather than a web page, because every "get a Twitch token" website is somebody
 * else's application asking for scopes on the creator's account — which is the thing this field
 * exists to avoid.
 */
const HINT =
	'A user access token for this site’s own Twitch application — for example from ' +
	'`twitch token -u` in the Twitch CLI. A token minted for a different application is refused.';

/** Twitch. */
export function twitchPlatform(): AccountPlatform {
	const oauth = twitchSignIn();

	const token: TokenLink = {
		hint: HINT,
		verify: verifyTwitchToken
	};

	return {
		id: 'twitch',
		label: 'Twitch',
		capabilities: ['sign-in', 'posts', 'live', 'social'],
		caveat: null,

		// OAuth first: it is the only method where the credential never passes through a form, and
		// the account page renders them in this order.
		methods: ['oauth', 'token'],
		oauth,
		token,

		// Both methods need the application's own client id — OAuth to start the flow, and a pasted
		// token because `/oauth2/validate` is what proves the token belongs to *this* application.
		// So one question answers both, and it is the one the sign-in provider already answers rather
		// than this file reading the same two environment variables and being able to disagree.
		usable: (method) => (method === 'oauth' || method === 'token') && oauth.usable()
	};
}
