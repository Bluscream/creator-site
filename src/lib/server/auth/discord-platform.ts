/**
 * Discord, as a platform an account can be linked to.
 *
 * Thin on purpose. The work of signing in with Discord is `./discord-sign-in.ts`; this says what a
 * Discord link is *for*, which is the question `./platform.ts` exists to answer.
 *
 * ### Why `sign-in` and `social` and nothing else
 *
 * The one scope requested is `identify` (see `./discord-sign-in.ts` for why), and `identify` buys
 * exactly two things: knowing who signed in, and a username and avatar worth showing on a links
 * page. It does not buy chat, which needs a bot in a guild — and a bot token is a *different*
 * credential with a different blast radius, so it stays its own thing rather than being folded into
 * somebody's personal link.
 *
 * ### Why no token method
 *
 * Discord has no personal access tokens. What looks like one is either a bot token, which is not an
 * account, or a user token scraped out of a browser session, which violates its terms and is a
 * password in all but name. Offering the field would invite somebody to paste the second one.
 */

import { discordSignIn } from './discord-sign-in.js';
import type { AccountPlatform } from './platform.js';

/** Discord. */
export function discordPlatform(): AccountPlatform {
	const oauth = discordSignIn();

	return {
		id: 'discord',
		label: 'Discord',
		capabilities: ['sign-in', 'social'],
		caveat: null,
		methods: ['oauth'],
		oauth,
		token: null,

		// `oauth` is the only declared method, so the question reduces to whether the application is
		// configured — which the sign-in provider already answers, rather than this file reading the
		// same two environment variables a second time and being able to disagree with it.
		usable: (method) => method === 'oauth' && oauth.usable()
	};
}
