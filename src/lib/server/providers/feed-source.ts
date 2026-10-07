/**
 * Posts out of an ordinary feed: RSS, Atom, RDF or JSON Feed.
 *
 * This is the kind most sources are — a blog, a Mastodon account, a PeerTube channel, a
 * feed-manufacturing bridge in front of a platform that has no API — and the kind the others
 * eventually reduce to.
 *
 * ### The parsing is a library's job
 *
 * The PHP this replaces hand-rolled it, and the plan named `rss-parser` as the replacement. That
 * turned out to be a bad pick on inspection: last published April 2023, on `xml2js` 0.5. The two
 * maintained candidates were `@rowanmanning/feed-parser` and `feedsmith`, and **feedsmith** wins on
 * two counts beyond being current — it exposes XML namespaces, which is how a YouTube Atom entry's
 * thumbnail and description are reachable at all, and it *generates* feeds as well as parsing them,
 * which is what an Atom or JSON Feed of the merged posts will need later. One library instead of
 * two.
 *
 * ### Four formats, one mapper each
 *
 * `parseFeed` returns a union discriminated on `format`, so each branch reads the fields that
 * format actually has rather than a lowest common denominator. The differences are not cosmetic:
 * an RSS item's link is a string and an Atom entry's is a list of typed links; RSS carries a
 * thumbnail in an enclosure and Atom in a media namespace; a JSON Feed item has both a text and an
 * HTML body. Flattening them first would mean losing a field for every format to spare writing
 * four short functions.
 *
 * Every branch ends at `buildPost`, so whatever arrives leaves as the same nine fields.
 */

import { ParseError, parseFeed } from 'feedsmith';
import type { Post } from '../../posts.js';
import { buildPost } from './post.js';
import type { RawPost, ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/**
 * How much of a response body is read before giving up.
 *
 * A feed is tens of kilobytes. This is a bound on a hostile or broken source handing back a stream
 * that never ends — a bridge returning an error page, a misconfigured server streaming a log — which
 * would otherwise be read into memory until the process died.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/** Nothing here understands a non-http scheme, and a `file:` target would be a local read. */
function badTarget(target: string): string | null {
	let url: URL;

	try {
		url = new URL(target);
	} catch {
		return 'That is not a URL.';
	}

	// Checked rather than assumed: a source's target comes from a configuration file, and `file:`
	// or `data:` here would turn a feed reader into a way to read the server's own disk.
	return url.protocol === 'https:' || url.protocol === 'http:'
		? null
		: 'A feed URL has to be http or https.';
}

/** The alternate link, which is the post itself rather than the feed or an enclosure. */
function alternateOf(links: readonly { href?: string; rel?: string }[] | undefined): string | null {
	const list = links ?? [];

	// `rel` is optional in Atom and defaults to `alternate` when absent, which is why a link with
	// no rel at all counts here.
	const alternate = list.find((link) => link.rel === undefined || link.rel === 'alternate');

	return alternate?.href ?? list[0]?.href ?? null;
}

/** An enclosure that is an image, which is the usual place a feed puts a thumbnail. */
function enclosureImage(
	enclosures: readonly { url?: string; type?: string }[] | undefined
): string | null {
	const image = (enclosures ?? []).find(
		(enclosure) => enclosure.type?.startsWith('image/') === true
	);

	return image?.url ?? null;
}

/** A thumbnail out of the media namespace, which is where YouTube and most video feeds put it. */
function mediaImage(media: MediaView | undefined): string | null {
	const fromGroup = media?.groups?.flatMap((group) => group.thumbnails ?? []) ?? [];
	const direct = media?.thumbnails ?? [];

	return [...fromGroup, ...direct].find((thumbnail) => thumbnail.url !== undefined)?.url ?? null;
}

/** A description out of the media namespace, which is the only place a YouTube entry has one. */
function mediaText(media: MediaView | undefined): string | null {
	return (
		media?.groups?.find((group) => group.description?.value !== undefined)?.description?.value ??
		null
	);
}

/**
 * As much of the media namespace as this reads.
 *
 * Declared here rather than imported because the library's own type for it is wide — every element
 * the specification allows — and naming the four fields used makes it obvious what a change
 * upstream could break.
 */
interface MediaView {
	readonly groups?: readonly {
		readonly thumbnails?: readonly { readonly url?: string }[];
		readonly description?: { readonly value?: string };
	}[];
	readonly thumbnails?: readonly { readonly url?: string }[];
}

export const feedSourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return badTarget(source.target);
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly Post[]> {
		const response = await context.fetch(source.target);

		if (!response.ok) {
			// The status is worth saying: a 404 and a 403 send an admin to different places, and
			// YouTube's throttling answers 404, which is confusing enough without hiding it.
			throw new SourceFailure(`The feed answered ${String(response.status)}.`);
		}

		const text = await body(response);

		let parsed: ReturnType<typeof parseFeed>;

		try {
			parsed = parseFeed(text);
		} catch (error) {
			// A bridge that has broken usually answers 200 with an HTML error page, so "not a feed"
			// is a routine outcome rather than an exceptional one.
			throw new SourceFailure(
				error instanceof ParseError
					? 'That URL did not return a feed.'
					: 'The feed could not be read.'
			);
		}

		return entriesOf(parsed, source);
	}
};

/** The response body, refusing one that is implausibly large. */
async function body(response: Response): Promise<string> {
	const declared = Number(response.headers.get('content-length') ?? '0');

	if (declared > MAX_BYTES) throw new SourceFailure('The feed is too large to read.');

	const text = await response.text();

	// Checked again after reading, because `content-length` is absent on a chunked response — which
	// is exactly how an endless stream would arrive.
	if (text.length > MAX_BYTES) throw new SourceFailure('The feed is too large to read.');

	return text;
}

/**
 * A date field as a string, or undefined.
 *
 * The library types several date fields as `unknown`, because what a feed puts in one is anybody's
 * guess — `pubDate` is RFC 822 by specification and in practice holds whatever the generator felt
 * like. Narrowed here rather than cast, and `when()` does the actual parsing.
 */
function asDate(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Whichever format arrived, as posts. */
function entriesOf(parsed: ReturnType<typeof parseFeed>, source: ResolvedSource): readonly Post[] {
	return rawOf(parsed)
		.map((entry) => buildPost(source, entry))
		.filter((post): post is Post => post !== null);
}

/**
 * One mapper per format.
 *
 * Four branches rather than one over a union, because the item types genuinely differ: an RSS item
 * has a `guid` and enclosures, an RDF item has neither and keeps its date and author in the Dublin
 * Core namespace, an Atom entry has a list of typed links where RSS has one string, and a JSON Feed
 * item has both a text and an HTML body. The type checker rejected the combined version, correctly.
 */
function rawOf(parsed: ReturnType<typeof parseFeed>): readonly RawPost[] {
	if (parsed.format === 'atom') {
		return (parsed.feed.entries ?? []).map((entry) => ({
			// Atom requires an id, but a bridge-manufactured feed often omits it, so the link is the
			// fallback — it is what makes a post unique anyway.
			id: entry.id ?? alternateOf(entry.links) ?? '',
			url: alternateOf(entry.links),
			title: entry.title?.value,
			// `summary` first: `content` is the whole post, and an excerpt of a whole post is a
			// worse excerpt than the one the author wrote. `media` last, which is where a YouTube
			// entry keeps the only description it has.
			excerpt:
				entry.summary?.value ??
				entry.content?.value ??
				mediaText(entry.media as MediaView | undefined),
			image:
				mediaImage(entry.media as MediaView | undefined) ??
				(entry.links ?? []).find((link) => link.rel === 'enclosure')?.href,
			// `published` is when it was posted; `updated` is the required one and the only date
			// many feeds set, so it is the fallback rather than the first choice.
			publishedAt: asDate(entry.published) ?? asDate(entry.updated),
			author: entry.authors?.[0]?.name
		}));
	}

	if (parsed.format === 'json') {
		return (parsed.feed.items ?? []).map((item) => ({
			id: item.id ?? item.url ?? '',
			url: item.url,
			title: item.title,
			excerpt: item.summary ?? item.content_text ?? item.content_html,
			image: item.image ?? item.banner_image,
			publishedAt: asDate(item.date_published) ?? asDate(item.date_modified),
			author: item.authors?.[0]?.name
		}));
	}

	if (parsed.format === 'rdf') {
		return (parsed.feed.items ?? []).map((item) => ({
			// RDF has no guid. `rdf:about` is the resource's identifier and is what it has instead.
			id: item.rdf?.about ?? item.link ?? '',
			url: item.link,
			title: item.title,
			excerpt: item.description ?? item.content?.encoded,
			image: mediaImage(item.media as MediaView | undefined),
			// Dublin Core, where RDF keeps both. Lists rather than single values, because the
			// namespace allows an element to repeat.
			publishedAt: asDate(item.dc?.dates?.[0]),
			author: item.dc?.creators?.[0]
		}));
	}

	return (parsed.feed.items ?? []).map((item) => ({
		// A `guid` is the id when there is one; plenty of feeds have none, and then the link
		// identifies the post.
		id: item.guid?.value ?? item.link ?? '',
		url: item.link,
		title: item.title,
		excerpt: item.description ?? item.content?.encoded,
		image: enclosureImage(item.enclosures) ?? mediaImage(item.media as MediaView | undefined),
		publishedAt: asDate(item.pubDate) ?? asDate(item.dc?.dates?.[0]),
		author: item.authors?.[0]?.name ?? item.dc?.creators?.[0]
	}));
}
