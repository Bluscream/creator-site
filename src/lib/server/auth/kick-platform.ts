/**
 * Kick, as a platform an account can be linked to.
 *
 * ### Why `posts` and `live` are not claimed yet
 *
 * Kick's API can answer both — `public/v1/channels` and `public/v1/livestreams` exist — but nothing
 * in this project reads them, and `channel:read` is a scope the creator would have to approve for a
 * reader that does not exist. A capability listed here is a promise the account page makes, and one
 * that leads nowhere is worse than one that is absent: it tells a creator their content will appear
 * and then it does not.
 *
 * They go on the list in the same commit as the reader, together with `channel:read` in
 * `./kick-sign-in.ts`. Until then this is an honest `sign-in` and `social`: the link proves who the
 * creator is on Kick and gives the public page a handle and an avatar to show, which both work with
 * the `user:read` scope already asked for.
 *
 * ### Why there is no paste-a-token method
 *
 * Twitch offers one because the Twitch CLI mints a user token for your own application in a single
 * command, so an operator who cannot register a redirect still has a route. Kick publishes no such
 * tool, and every "get a Kick token" page is somebody else's application asking for scopes on the
 * creator's account — which is the thing the method exists to avoid. Offering a field nobody can
 * honestly fill is worse than not offering it, so Kick is OAuth only.
 *
 * `verifyKickToken` is still exported from the sign-in module and still tested, because the
 * introspection it performs is the same check the OAuth path makes. Wiring it to a form is a
 * decision, not a missing line.
 */

import * as m from '#lib/paraglide/messages.js';
import { kickSignIn } from './kick-sign-in.js';
import type { AccountPlatform } from './platform.js';

/** Kick. */
export function kickPlatform(): AccountPlatform {
	const oauth = kickSignIn();

	return {
		id: 'kick',
		label: 'Kick',
		capabilities: ['sign-in', 'social'],

		// Said out loud on the account page rather than discovered later, because the obvious reason
		// to link Kick is the one thing this link does not yet do.
		caveat: () => m.admin_kick_caveat(),

		methods: ['oauth'],
		oauth,
		token: null,

		usable: (method) => method === 'oauth' && oauth.usable()
	};
}
