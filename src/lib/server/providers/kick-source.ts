/**
 * Kick, read through its own maintained plugin.
 *
 * ### Why a plugin and not an API
 *
 * Kick publishes no documented public API for a channel's past broadcasts, and its own web client
 * calls an endpoint fronted by Cloudflare that answers a plain request with a challenge page. The
 * route that works is the one the GrayJay app uses, and the reason to borrow it rather than
 * reimplement it is that it is **maintained by people who watch Kick change** — which is the whole
 * argument for this kind of source, and something a hand-written reader here could not match.
 *
 * ### What is left in this file
 *
 * Only the Kick-specific part: which spellings of a channel name to accept. Everything else —
 * driving the plugin, translating what it returns, routing its requests through this project's own
 * `fetch`, and the costs that come with all of that — is in `grayjay-source.ts`, shared with every
 * other platform read the same way. See that file for the sandbox, the AGPL note and the per-read
 * cost.
 *
 * Kick keeps its own kind rather than becoming a `grayjay` source because a handle is what somebody
 * has to hand for Kick — `xqc`, not `https://kick.com/xqc` — and accepting that is worth a file.
 */

import type { ContentPiece } from '../../posts.js';
import { readThrough, secondsOf, thumbnailOf } from './grayjay-source.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/** The official plugin, from Kick's own published url. Never vendored — see `grayjay-source.ts`. */
const MANIFEST = 'https://plugins.grayjay.app/Kick/KickConfig.json';

/**
 * What a source's `target` may be.
 *
 * A Kick channel is a single path segment, so this accepts the handle on its own, with a leading
 * `@`, or as any `kick.com` url containing it — because all three are what somebody has to hand,
 * and rejecting two of them would be a configuration error for no reason.
 */
const HANDLE = /^[A-Za-z0-9_]{2,30}$/;

const ADVICE = 'Set this source to a Kick channel, for example `kick.com/xqc` or just `xqc`.';

// Re-exported because they are read here and tested here, and because a caller reaching for them
// from this module rather than the shared one is reading the right file for Kick.
export { secondsOf, thumbnailOf };

/** The channel handle in `target`, or null when there is not one. */
export function handleOf(target: string): string | null {
	const trimmed = target.trim().replace(/^@/, '');

	if (HANDLE.test(trimmed)) return trimmed;

	let url;

	try {
		url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}

	if (!/(^|\.)kick\.com$/i.test(url.hostname)) return null;

	const first = url.pathname.split('/').find((part) => part !== '');

	return first !== undefined && HANDLE.test(first) ? first : null;
}

export const kickSourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(ADVICE);

		return readThrough(source, context, {
			manifest: MANIFEST,
			channel: `https://kick.com/${encodeURIComponent(handle)}`,
			label: 'Kick',
			author: handle,

			// The unsigned, permanent half of the author's identity, used when the plugin gives no
			// author of its own.
			profileUrl: `https://kick.com/${encodeURIComponent(handle)}`
		});
	}
};
