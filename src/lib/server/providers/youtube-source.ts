/**
 * YouTube uploads, through the channel feed YouTube still publishes.
 *
 * This is the feed provider plus one job: working out the feed's url from whatever the
 * configuration says. The feed is addressed by **channel id** — the `UC…` string — and nothing a
 * person knows about their own channel is that string. They know `@someone`, or the url in their
 * address bar. Making somebody dig a `UC…` id out of a page's source before they can add their own
 * channel is a bad enough step to be worth one cached request to avoid.
 *
 * So the target may be any of:
 *
 * - `UChEyxtmrh1vGIfBPEyOls7Q` — the channel id, used as it is
 * - `@someone` — resolved by reading the channel page once, then remembered for a month
 * - `https://www.youtube.com/@someone`, or `…/channel/UC…`, or the older `/c/name` and `/user/name`
 * - a full `https://…/feeds/videos.xml?…` url, passed straight through
 *
 * ### Two things about YouTube's feed endpoint that look like bugs and are not
 *
 * 1. **It answers 404 to a user agent that does not begin `Mozilla/5.0`.** It is not checking for a
 *    real browser — `Mozilla/5.0 (compatible; …)` is accepted — it is checking for that prefix.
 *    `posts.ts` sends that form for exactly this reason, which is why the header belongs to the
 *    context rather than to each provider.
 * 2. **When it throttles by IP it answers 404 or 500, never 429.** The identical request returns 200
 *    once and 404 twice twenty seconds later. This is the reason posts are cached per source and a
 *    failed refresh keeps the last good answer rather than blanking the platform.
 */

import type { Post } from '../../posts.js';
import { feedSourceProvider } from './feed-source.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/** A channel id: `UC` and 22 more characters of base64url. */
const CHANNEL_ID = /^UC[\w-]{22}$/;

/** A handle, with or without its `@`. YouTube allows 3–30 of these characters. */
const HANDLE = /^@?[\w.-]{3,30}$/;

/** The same, when it appears inside a url path. */
const PATH_HANDLE = /\/(@[\w.-]{3,30})/;
const PATH_CHANNEL = /\/channel\/(UC[\w-]{22})/;

/** `/c/name` and `/user/name`, the two pre-handle forms. Both resolve the way a handle does. */
const PATH_LEGACY = /\/(?:c|user)\/([\w.-]{3,30})/;

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

/**
 * How long a resolved handle is remembered.
 *
 * A month, because a channel id never changes — a *handle* can be reassigned, which is the only
 * reason this expires at all. Resolution costs a request against the channel page, and doing that
 * on every refresh would double this provider's traffic against an endpoint that already throttles.
 */
const RESOLVE_TTL = 30 * 24 * 60 * 60;

/** What the configured target actually is. */
type Identity =
	| { readonly kind: 'id'; readonly value: string }
	| { readonly kind: 'handle'; readonly value: string }
	| { readonly kind: 'feed'; readonly value: string };

const ADVICE = "Use the channel's @handle, its UC… id, or a link to it.";

/** The id appearing in the channel page, or null. */
function idIn(html: string): string | null {
	// `externalId` first: the id appears several times in the page, and this is the one that is
	// always *this* channel rather than a recommendation or a link in a description.
	return (
		/"externalId"\s*:\s*"(UC[\w-]{22})"/.exec(html)?.[1] ??
		/channel_id=(UC[\w-]{22})/.exec(html)?.[1] ??
		null
	);
}

/** What `target` identifies, or null when it identifies nothing. */
export function identify(target: string): Identity | null {
	const trimmed = target.trim();

	if (trimmed === '') return null;

	// Already a feed url — including one pointing at a bridge or a mirror, which is why this is not
	// narrowed to youtube.com.
	if (trimmed.includes('/feeds/videos.xml')) {
		return /^https:\/\//i.test(trimmed) ? { kind: 'feed', value: trimmed } : null;
	}

	if (CHANNEL_ID.test(trimmed)) return { kind: 'id', value: trimmed };

	if (/^https?:\/\//i.test(trimmed)) {
		let path: string;

		try {
			path = new URL(trimmed).pathname;
		} catch {
			return null;
		}

		const channel = PATH_CHANNEL.exec(path)?.[1];

		if (channel !== undefined) return { kind: 'id', value: channel };

		const handle = PATH_HANDLE.exec(path)?.[1] ?? PATH_LEGACY.exec(path)?.[1];

		return handle === undefined ? null : { kind: 'handle', value: handle };
	}

	return HANDLE.test(trimmed) ? { kind: 'handle', value: trimmed } : null;
}

/**
 * The channel id for a handle, from the store or by reading the channel page once.
 *
 * On a failed lookup a stale stored id beats failing: a channel id does not change, so an old one
 * is still right even while the lookup itself is being throttled.
 */
async function channelId(handle: string, context: SourceContext): Promise<string> {
	const key = `youtube-channel\0${handle.replace(/^@/, '').toLowerCase()}`;
	const stored = await context.store.get(key);

	if (stored !== null && stored.age < RESOLVE_TTL) return stored.value;

	const at = `@${handle.replace(/^@/, '')}`;
	const response = await context.fetch(`https://www.youtube.com/${encodeURIComponent(at)}`);

	if (!response.ok) {
		if (stored !== null) return stored.value;

		throw new SourceFailure(`YouTube answered ${String(response.status)} for ${at}.`);
	}

	const found = idIn(await response.text());

	if (found === null) {
		if (stored !== null) return stored.value;

		throw new SourceFailure(`Could not find a channel id for ${at}.`);
	}

	await context.store.put(key, found);

	return found;
}

/** The feed url for whatever the target identified. */
async function feedUrl(identity: Identity, context: SourceContext): Promise<string> {
	if (identity.kind === 'feed') return identity.value;

	const id = identity.kind === 'id' ? identity.value : await channelId(identity.value, context);

	return `${FEED_URL}${encodeURIComponent(id)}`;
}

export const youtubeSourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return identify(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly Post[]> {
		const identity = identify(source.target);

		// `unusable` is asked first by the orchestrator, so this is unreachable through it — but a
		// provider has to be correct when called directly, and refusing is better than fetching
		// `https://www.youtube.com/feeds/videos.xml?channel_id=` with nothing after it.
		if (identity === null) throw new SourceFailure(ADVICE);

		// Delegated with a rewritten target, so there is one feed parser rather than two. The
		// orchestrator's own cache key is built from the *original* source, so this does not cache
		// the posts twice.
		return feedSourceProvider.read(
			{ ...source, target: await feedUrl(identity, context) },
			context
		);
	}
};
