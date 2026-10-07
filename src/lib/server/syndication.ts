/**
 * The merged posts as a feed somebody can subscribe to.
 *
 * The point of this project's post layer is that a creator's output is scattered across five
 * platforms and nobody follows all five. `/api/posts` solves that for the site's own page. This
 * solves it for everyone else: one Atom or JSON Feed url carrying the same merged, deduplicated,
 * newest-first list, which a reader app can poll without knowing that TikTok has no API.
 *
 * Generated with feedsmith rather than by hand. A feed is a format with escaping rules, required
 * elements and a date format, and the same library already parses four of them here — so writing
 * the fifth by string concatenation would be the one place in this project where markup is built by
 * hand.
 *
 * ### Two things the generator does quietly
 *
 * 1. **An Atom `title` is an object, not a string.** `{ value: 'x' }`, because Atom titles carry a
 *    `type` and may be markup. Passing a bare string is not an error — the element is simply
 *    *omitted*, and `<title>` is required on both the feed and every entry, so the output would be
 *    invalid Atom that still parses as XML. The types catch it; this comment is why nobody should
 *    "simplify" it back.
 * 2. **`generateJsonFeed` returns an object**, not a string, so the route serialises it. Which is
 *    the right split — a feed is data until something sends it.
 *
 * ### What is deliberately not here
 *
 * No `<content>`. The posts carry an excerpt, never a platform's rendered body (see `posts.ts`), so
 * there is nothing to put in one. A reader that wants the whole thing follows the link, which is
 * what the link is for.
 */

import { generateAtomFeed, generateJsonFeed } from 'feedsmith';
import { pictureOf } from '../canonical.js';
import type { ContentPiece, PostsResult } from '../posts.js';

/** How the feed describes itself, when nothing more specific is configured. */
const FALLBACK_TITLE = 'Posts';

/** Where a feed's own identity comes from. */
export interface FeedIdentity {
	/** The site's origin, e.g. `https://example.com`, with no trailing slash. */
	readonly origin: string;

	/** The path this feed is served at, e.g. `/feed.atom`. */
	readonly path: string;

	/** What to call it. */
	readonly title: string;
}

/**
 * When the feed last changed.
 *
 * The newest post's date, not the time of generation. A feed whose `updated` moved every time it
 * was fetched would defeat every conditional request a reader makes — and the thing that changed
 * is the posts, which is what the field is for. Falls back to now for an empty feed, because the
 * element is required and there is no post to date it by.
 */
export function updatedAt(posts: readonly ContentPiece[], now: Date = new Date()): Date {
	for (const post of posts) {
		if (post.at === null) continue;

		const parsed = new Date(post.at);

		// Already sorted newest-first by the orchestrator, so the first dated post is the newest.
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}

	return now;
}

/** A post's date, or null when it has none a reader could use. */
function dateOf(post: ContentPiece): Date | null {
	if (post.at === null) return null;

	const parsed = new Date(post.at);

	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The Atom feed, as XML.
 *
 * Every entry's `id` is the post's own — `youtube:abc`, already namespaced by source — rather than
 * its url. A reader keys read/unread state on the id, and a platform that changes a url's shape
 * would otherwise make every old post unread again.
 */
export function atom(result: PostsResult, identity: FeedIdentity): string {
	const self = `${identity.origin}${identity.path}`;

	return generateAtomFeed({
		id: self,
		title: { value: identity.title },
		updated: updatedAt(result.posts),
		links: [
			{ href: self, rel: 'self', type: 'application/atom+xml' },
			{ href: `${identity.origin}/`, rel: 'alternate', type: 'text/html' }
		],
		entries: result.posts.map((post) => entryOf(post)),
		// `text`, not `value` — unlike every other Atom text construct here, which the type checker
		// is the only reason anyone would notice.
		generator: { text: 'creator-site', uri: 'https://github.com/Bluscream/creator-site' }
	});
}

/** One post as an Atom entry. */
function entryOf(post: ContentPiece) {
	const date = dateOf(post);
	const picture = pictureOf(post);

	return {
		id: post.id,
		// `title` falls back to the excerpt for the platforms whose posts have no title — the same
		// rule the UI follows, so a feed reader and the site agree on what a post is called.
		title: { value: post.title === '' ? post.body || post.url : post.title },
		links: [{ href: post.url, rel: 'alternate', type: 'text/html' }],
		...(post.body === '' ? {} : { summary: { value: post.body } }),
		...(post.author === null
			? {}
			: {
					authors: [
						{
							name: post.author.name,
							...(post.author.profileUrl === undefined ? {} : { uri: post.author.profileUrl })
						}
					]
				}),

		// `updated` is required, so an undated post is dated by the feed's own newest — the honest
		// alternative to dropping it, since the post itself is real.
		updated: date ?? updatedAt(post.at === null ? [] : [post]),
		...(date === null ? {} : { published: date }),

		// The source is the one piece of per-post metadata worth syndicating: a reader can see that
		// a post came from YouTube rather than Bluesky without parsing its url.
		// A source-less piece carries no category rather than an empty one, because Atom's `term` is
		// required and a reader filtering on it would otherwise see a category named "".
		...(post.source === null ? {} : { categories: [{ term: post.source }] }),

		// Atom has no element for a post's picture, so this is the `media` namespace — which is how
		// YouTube's own Atom feed ships thumbnails, so it is what readers already understand. The
		// generator declares the namespace on the feed only when an entry uses it.
		...(picture === null ? {} : { media: { thumbnails: [{ url: picture.url }] } })
	};
}

/**
 * The JSON Feed, as a value. The route serialises it.
 *
 * `unknown` because that is what the generator returns, and narrowing it here would be a cast
 * asserting something this module did not check. The route stringifies it, which `unknown` allows.
 */
export function jsonFeed(result: PostsResult, identity: FeedIdentity): unknown {
	return generateJsonFeed({
		title: identity.title,
		home_page_url: `${identity.origin}/`,
		feed_url: `${identity.origin}${identity.path}`,
		items: result.posts.map((post) => itemOf(post))
	});
}

/** One post as a JSON Feed item. */
function itemOf(post: ContentPiece) {
	const date = dateOf(post);
	const picture = pictureOf(post);

	return {
		id: post.id,
		url: post.url,
		...(post.title === '' ? {} : { title: post.title }),
		...(post.body === '' ? {} : { summary: post.body }),
		...(picture === null ? {} : { image: picture.url }),
		...(date === null ? {} : { date_published: date }),
		...(post.author === null
			? {}
			: {
					authors: [
						{
							name: post.author.name,
							...(post.author.profileUrl === undefined ? {} : { url: post.author.profileUrl })
						}
					]
				}),
		...(post.source === null ? {} : { tags: [post.source] })
	};
}

/** The title to publish under: the configured one, or something valid derived from the host. */
export function titleFrom(configured: string | undefined, host: string): string {
	if (configured !== undefined) return configured;

	// A bare host reads as a title better than "Posts" does, and an installation behind a domain has
	// told us its name without being asked.
	return host === '' ? FALLBACK_TITLE : `${host} — ${FALLBACK_TITLE.toLowerCase()}`;
}
