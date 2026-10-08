/**
 * Bluesky posts, through the public AppView.
 *
 * The easiest platform here by a distance: `app.bsky.feed.getAuthorFeed` is served unauthenticated
 * from `public.api.bsky.app`, so reading somebody's public posts needs no application, no key and
 * no token — one GET with a handle on it. (Search is the exception and does need auth; this does
 * not use it.)
 *
 * Replies are filtered out server-side with `posts_no_replies`, because the feed is "what has this
 * person put out" and a reply to a stranger reads as noise beside a video upload.
 *
 * ### Reposts are dropped here, not there
 *
 * No `filter` value excludes them — `posts_no_replies` was measured against a live account and the
 * newest entry it returned was somebody else's post, reposted. A repost's entry carries the
 * *original* author, so left in it renders as a stranger's name and a link to a stranger's profile
 * inside this creator's feed. The AppView marks one with a `reason` on the entry rather than on the
 * post, which is the only way to tell it apart, so the filtering happens after the fetch.
 *
 * ### A Bluesky post has no title
 *
 * Nothing in the record is one. The first line of the text stands in, and the whole text becomes
 * the excerpt — otherwise every row would be headed by its own body. Where the PHP this replaces
 * fell back to the literal string `'ContentPiece'` for a post whose text is empty, this leaves the title
 * empty: `ContentPiece.title` is documented as rendering from the excerpt when it is blank, and a hardcoded
 * English noun inside a provider is a string no translation could reach.
 */

import { z } from 'zod';
import type { ContentPiece } from '../../posts.js';
import { buildPost, headline } from './post.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

/** How many to ask for. The AppView's own ceiling is 100; a feed row shows far fewer. */
const LIMIT = 25;

/**
 * A handle is a domain name.
 *
 * Bluesky's own are `name.bsky.social`, but the whole point of the scheme is that any domain can be
 * one — so this validates the shape of a domain rather than a `.bsky.social` suffix.
 */
const HANDLE = /^@?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

const ADVICE = 'Use the account’s handle, like name.bsky.social.';

/**
 * As much of the AppView's response as this reads.
 *
 * Parsed rather than trusted, and loosely: every field is optional because an entry that is missing
 * one should be skipped rather than take the whole fetch down, and because the AppView adds fields
 * without notice. `loose` is deliberate for the same reason — rejecting an unknown field would make
 * every addition upstream a breakage here.
 */
const postSchema = z
	.object({
		uri: z.string().optional(),
		cid: z.string().optional(),
		record: z
			.object({ text: z.string().optional(), createdAt: z.string().optional() })
			.loose()
			.optional(),
		author: z
			.object({ handle: z.string().optional(), displayName: z.string().optional() })
			.loose()
			.optional(),
		embed: z.unknown().optional()
	})
	.loose();

/** One entry of the author feed. */
type FeedPost = z.output<typeof postSchema>;

const responseSchema = z.object({
	feed: z
		.array(
			z
				.object({
					post: postSchema.optional(),

					// Present only on a repost (or a feed-generator's own reason). Its presence is the
					// signal; nothing inside it is read.
					reason: z.unknown().optional()
				})
				.loose()
		)
		.optional()
});

/** An embed, as far as the one field this wants is concerned. */
const embedSchema = z.object({
	images: z.array(z.object({ thumb: z.string().optional() }).loose()).optional(),
	external: z.object({ thumb: z.string().optional() }).loose().optional(),
	media: z.unknown().optional()
});

/**
 * The post's first picture.
 *
 * Embeds come in several shapes. `images` is the one that carries pictures, and it appears nested
 * under `media` as well, for a quote-post that has an image of its own. `external` is a link card's
 * preview, which is the only picture a post whose content is a link has.
 */
function imageOf(embed: unknown): string | null {
	const parsed = embedSchema.safeParse(embed);

	if (!parsed.success) return null;

	const { images, external, media } = parsed.data;
	const thumb = images?.find((image) => image.thumb !== undefined)?.thumb ?? external?.thumb;

	if (thumb !== undefined) return thumb;

	// One level down, and one level only: `recordWithMedia` nests an embed under `media`, and
	// recursing without a bound would follow a quote of a quote of a quote.
	return media === undefined ? null : shallowImageOf(media);
}

/** {@link imageOf} without the recursion, for the one nested level that exists. */
function shallowImageOf(embed: unknown): string | null {
	const parsed = embedSchema.safeParse(embed);

	if (!parsed.success) return null;

	return (
		parsed.data.images?.find((image) => image.thumb !== undefined)?.thumb ??
		parsed.data.external?.thumb ??
		null
	);
}

/** The handle `target` names, lower-cased, or null. */
export function handleOf(target: string): string | null {
	let value = target.trim();

	if (/^https?:\/\//i.test(value)) {
		// `https://bsky.app/profile/<handle>`
		const found = /\/profile\/([^/?#]+)/.exec(value)?.[1];

		if (found === undefined) return null;

		value = found;
	}

	value = value.replace(/^@/, '');

	return HANDLE.test(value) ? value.toLowerCase() : null;
}

export const blueskySourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(ADVICE);

		const query = new URLSearchParams({
			actor: handle,
			limit: String(LIMIT),
			filter: 'posts_no_replies'
		});

		const response = await context.fetch(`${API}?${query.toString()}`);

		if (response.status === 400) {
			// What the AppView answers for a handle nobody holds. Worth saying plainly rather than
			// as a status code, because it is the one failure here an admin can actually fix.
			throw new SourceFailure(`Bluesky has no account called ${handle}.`);
		}

		if (!response.ok) {
			throw new SourceFailure(`Bluesky answered ${String(response.status)}.`);
		}

		const parsed = responseSchema.safeParse(await response.json());

		if (!parsed.success) throw new SourceFailure('Bluesky sent something unexpected.');

		return (parsed.data.feed ?? [])
			.filter((entry) => entry.reason === undefined)
			.map((entry) => toPost(entry.post, source))
			.filter((post): post is ContentPiece => post !== null);
	}
};

/** One feed entry as a post, or null when it is not one. */
function toPost(post: FeedPost | undefined, source: ResolvedSource): ContentPiece | null {
	if (post === undefined) return null;

	const { uri, cid, record, author, embed } = post;
	const handle = author?.handle;

	if (uri === undefined || handle === undefined) return null;

	// An `at://` uri is not something a browser can open. The public web url is built from the
	// author's handle and the record key, which is the last segment of the uri.
	const rkey = uri.slice(uri.lastIndexOf('/') + 1);

	if (rkey === '') return null;

	const text = record?.text ?? '';

	return buildPost(source, {
		// Read through `app.bsky.feed.getAuthorFeed` on the public AppView with no token, which is
		// what makes this claim safe rather than optimistic: an unauthenticated AppView read cannot
		// see a post the author has not published. Bluesky has no unlisted tier today.
		visibility: 'public',
		id: cid ?? rkey,
		url: `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`,
		title: headline(text),
		excerpt: text,
		image: imageOf(embed),
		publishedAt: record?.createdAt,
		// The display name is what a reader recognises; the handle is what always exists.
		author:
			author?.displayName !== undefined && author.displayName !== '' ? author.displayName : handle
	});
}
