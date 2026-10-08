/**
 * YouTube, as a platform an account can be linked to.
 *
 * The first entry that is **not** a sign-in provider, and the one that showed `./platform.ts`'s two
 * independent lists were not actually independent at the routes — see `linkProvider` in
 * `./sign-in-registry.js`.
 *
 * ### Why not `sign-in`
 *
 * Signing in with Google would mean requesting a YouTube scope to authenticate, and failing for
 * anybody whose Google account has no channel. The identity this platform produces is a *channel*,
 * which is the right thing for a site that shows a creator's work and the wrong thing to key an
 * account on.
 *
 * ### Why not `posts`, when the video feed already works
 *
 * The feed comes from YouTube's public RSS endpoint, which needs no credential at all — so unlike
 * Twitch, a linked account would not feed it. Claiming `posts` here would say "link this and your
 * videos appear", when the videos appear either way and the link changes nothing about them.
 *
 * It becomes true the day a reader uses the Data API instead, which is worth doing — RSS gives the
 * last 15 videos and no durations, view counts or live state, all of which `ContentPiece` now has
 * fields for. `youtube.readonly` is already the scope that would need.
 */

import * as m from '#lib/paraglide/messages.js';
import { youtubeSignIn } from './youtube-sign-in.js';
import type { AccountPlatform } from './platform.js';

/** YouTube. */
export function youtubePlatform(): AccountPlatform {
	const oauth = youtubeSignIn();

	return {
		id: 'youtube',
		label: 'YouTube',

		// No `sign-in`, and no `posts`. See the notes above — both are deliberate rather than pending.
		capabilities: ['social'],

		caveat: () => m.admin_youtube_caveat(),

		methods: ['oauth'],
		oauth,
		token: null,

		usable: (method) => method === 'oauth' && oauth.usable()
	};
}
