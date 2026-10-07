/**
 * That the merged posts become a feed a reader can actually subscribe to.
 *
 * The Atom assertions generate the feed and then **parse it back** with a real feed parser, looking
 * for the elements the specification requires rather than matching strings. That is deliberate: the
 * generator silently *omits* an element given the wrong shape — an Atom `title` is `{ value }`, not
 * a string — so output that looks fine and is invalid Atom is the exact failure this has to catch,
 * and a substring match would not.
 *
 * The parser is feedsmith's, the same library that writes the feed. That is a real limit: a bug
 * where it both writes and reads the same wrong thing would pass. The alternative was depending on
 * `fast-xml-parser` directly, which is only a transitive dependency here and would break whenever
 * feedsmith changed its own. So where a round-trip cannot prove something — a namespace
 * declaration, escaping — the raw XML is asserted as well.
 */

import { parseFeed } from 'feedsmith';
import { describe, expect, it } from 'vitest';
import { atom, jsonFeed, titleFrom, updatedAt } from './syndication.js';
import type { ContentPiece, PostsResult } from '../posts.js';

const identity = {
	origin: 'https://example.com',
	path: '/feed.atom',
	title: 'Someone’s posts'
};

/** A post, with everything a feed could want. */
function post(overrides: Partial<ContentPiece> = {}): ContentPiece {
	return {
		id: 'youtube:abc',
		source: 'youtube',
		platform: 'youtube',
		title: 'VR und Chill mit dem Otter',
		url: 'https://www.youtube.com/watch?v=abc',
		kind: 'video',
		body: 'Welcome to the Otterspace',
		at: '2026-10-07T16:30:15.000Z',
		author: { name: 'BleichiLoveless' },
		media: [{ url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', kind: 'image' }],
		...overrides
	};
}

function result(posts: readonly ContentPiece[]): PostsResult {
	return { available: true, posts, sources: [], age: 0, stale: false };
}

/** Generated Atom, parsed back. Throws if what was written is not a feed at all. */
function feedOf(posts: readonly ContentPiece[]) {
	const read = parseFeed(atom(result(posts), identity));

	if (read.format !== 'atom') throw new Error(`generated ${read.format}, not atom`);

	return read.feed;
}

/** The first entry of the parsed feed. */
function entryOf(posts: readonly ContentPiece[]) {
	const entry = feedOf(posts).entries?.[0];

	if (entry === undefined) throw new Error('no entries');

	return entry;
}

describe('the Atom feed', () => {
	it('is Atom, as far as a feed parser is concerned', () => {
		// `feedOf` throws on any other format, so reaching here is the assertion. A document that
		// did not parse as a feed at all would fail every test below for the wrong reason.
		expect(feedOf([post()])).toBeDefined();
	});

	it('carries the three elements Atom requires of a feed', () => {
		// `id`, `title` and `updated`. Without any one of them the document is invalid, and the
		// generator omits rather than complains.
		const feed = feedOf([post()]);

		expect(feed.id).toBe('https://example.com/feed.atom');
		expect(feed.title?.value).toBe('Someone’s posts');
		expect(feed.updated).toBe('2026-10-07T16:30:15.000Z');
	});

	it('carries the three elements Atom requires of an entry', () => {
		const entry = entryOf([post()]);

		expect(entry.id).toBe('youtube:abc');
		expect(entry.title?.value).toBe('VR und Chill mit dem Otter');
		expect(entry.updated).toBe('2026-10-07T16:30:15.000Z');
	});

	it('says where it is and what it is an alternate of', () => {
		const links = feedOf([post()]).links ?? [];

		expect(links.find((link) => link.rel === 'self')).toMatchObject({
			href: 'https://example.com/feed.atom',
			type: 'application/atom+xml'
		});
		expect(links.find((link) => link.rel === 'alternate')?.href).toBe('https://example.com/');
	});

	it('identifies an entry by the post id, not its url', () => {
		// A reader keys read/unread state on the id. A platform changing the shape of its urls would
		// otherwise mark every old post unread again.
		const entry = entryOf([post({ url: 'https://www.youtube.com/shorts/abc' })]);

		expect(entry.id).toBe('youtube:abc');
	});

	it('links to the post', () => {
		expect(entryOf([post()]).links?.[0]?.href).toBe('https://www.youtube.com/watch?v=abc');
	});

	it('names the source as a category, so a reader can tell platforms apart', () => {
		expect(entryOf([post()]).categories?.[0]?.term).toBe('youtube');
	});

	it('names the author', () => {
		expect(entryOf([post()]).authors?.[0]?.name).toBe('BleichiLoveless');
	});

	it('summarises with the excerpt', () => {
		expect(entryOf([post()]).summary?.value).toBe('Welcome to the Otterspace');
	});

	it('ships the picture through the media namespace, as YouTube’s own feed does', () => {
		// Atom has no element for one. `media:thumbnail` is what readers already understand, and the
		// raw assertion is here because a round-trip cannot show that the namespace was declared.
		const xml = atom(result([post()]), identity);

		expect(xml).toContain('xmlns:media="http://search.yahoo.com/mrss/"');
		expect(entryOf([post()]).media?.thumbnails?.[0]?.url).toBe(
			'https://i.ytimg.com/vi/abc/hqdefault.jpg'
		);
	});

	it('leaves the media namespace out when no post has a picture', () => {
		expect(atom(result([post({ media: [] })]), identity)).not.toContain('search.yahoo.com/mrss');
	});

	it('escapes a title that would otherwise break the document', () => {
		// Not a hypothetical: titles contain ampersands constantly. A bare `&` in XML is a parse
		// error, so a title that survives the round-trip intact is the proof it was escaped.
		const awkward = 'Otters & <friends>';

		expect(entryOf([post({ title: awkward })]).title?.value).toBe(awkward);
	});

	it('titles a post that has none from its excerpt, as the UI does', () => {
		// Bluesky and TikTok posts have no title. An entry with an empty one is valid and useless.
		const entry = entryOf([post({ title: '', body: 'A post about otters' })]);

		expect(entry.title?.value).toBe('A post about otters');
	});

	it('falls back to the url for a post with neither', () => {
		expect(entryOf([post({ title: '', body: '' })]).title?.value).toBe(
			'https://www.youtube.com/watch?v=abc'
		);
	});

	it('omits the summary rather than emitting an empty one', () => {
		expect(entryOf([post({ body: '' })]).summary).toBeUndefined();
	});

	it('omits the author rather than emitting a blank one', () => {
		expect(entryOf([post({ author: null })]).authors).toBeUndefined();
	});

	it('still dates an undated post, because updated is required', () => {
		const entry = entryOf([post({ at: null })]);

		expect(entry.updated).toBeDefined();
		expect(entry.published).toBeUndefined();
	});

	it('keeps every post', () => {
		const posts = [post({ id: 'a' }), post({ id: 'b' }), post({ id: 'c' })];

		expect(feedOf(posts).entries).toHaveLength(3);
	});

	it('is valid with no posts at all', () => {
		const feed = feedOf([]);

		expect(feed.id).toBe('https://example.com/feed.atom');
		expect(feed.title?.value).toBe('Someone’s posts');
		expect(feed.updated).toBeDefined();
		expect(feed.entries ?? []).toStrictEqual([]);
	});
});

describe('when the feed says it last changed', () => {
	it('is the newest post’s date, not now', () => {
		// A feed whose `updated` moved on every fetch would defeat every conditional request a
		// reader makes, and would say the feed changed when only the clock did.
		const when = updatedAt([
			post({ at: '2026-10-07T16:30:15.000Z' }),
			post({ at: '2026-01-01T00:00:00.000Z' })
		]);

		expect(when.toISOString()).toBe('2026-10-07T16:30:15.000Z');
	});

	it('skips an undated post to reach a dated one', () => {
		const when = updatedAt([post({ at: null }), post({ at: '2026-05-05T00:00:00.000Z' })]);

		expect(when.toISOString()).toBe('2026-05-05T00:00:00.000Z');
	});

	it('skips a date that will not parse', () => {
		const when = updatedAt([
			post({ at: 'last Tuesday' }),
			post({ at: '2026-05-05T00:00:00.000Z' })
		]);

		expect(when.toISOString()).toBe('2026-05-05T00:00:00.000Z');
	});

	it('is now for a feed with nothing in it', () => {
		const now = new Date('2026-10-07T00:00:00.000Z');

		expect(updatedAt([], now)).toBe(now);
	});
});

/**
 * The JSON Feed shape these tests assert.
 *
 * Declared rather than indexed into an opaque record, so the assertions read as dot access and a
 * field renamed upstream is a type error rather than an `undefined` that quietly passes.
 */
interface JsonFeed {
	readonly version?: string;
	readonly title?: string;
	readonly feed_url?: string;
	readonly home_page_url?: string;
	readonly items?: readonly Record<string, unknown>[];
}

describe('the JSON feed', () => {
	function json(posts: readonly ContentPiece[]): JsonFeed {
		return jsonFeed(result(posts), { ...identity, path: '/feed.json' }) as JsonFeed;
	}

	function item(posts: readonly ContentPiece[]): Record<string, unknown> {
		const first = json(posts).items?.[0];

		if (first === undefined) throw new Error('no items');

		return first;
	}

	it('declares the version url the specification requires', () => {
		expect(json([post()]).version).toBe('https://jsonfeed.org/version/1.1');
	});

	it('says where it is and what site it belongs to', () => {
		expect(json([post()]).feed_url).toBe('https://example.com/feed.json');
		expect(json([post()]).home_page_url).toBe('https://example.com/');
		expect(json([post()]).title).toBe('Someone’s posts');
	});

	it('carries the two fields an item requires, and the rest', () => {
		expect(item([post()])).toStrictEqual({
			id: 'youtube:abc',
			url: 'https://www.youtube.com/watch?v=abc',
			title: 'VR und Chill mit dem Otter',
			summary: 'Welcome to the Otterspace',
			image: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
			date_published: '2026-10-07T16:30:15.000Z',
			authors: [{ name: 'BleichiLoveless' }],
			tags: ['youtube']
		});
	});

	it('omits a field rather than carrying it empty', () => {
		const one = item([post({ title: '', body: '', media: [], author: null })]);

		expect(Object.keys(one).toSorted()).toStrictEqual(['date_published', 'id', 'tags', 'url']);
	});

	it('omits the date rather than inventing one, unlike Atom', () => {
		// JSON Feed has no required date, so there is nothing to invent and an absent one is honest.
		expect(item([post({ at: null })])).not.toHaveProperty('date_published');
	});

	it('is valid with no posts at all', () => {
		expect(json([]).items ?? []).toStrictEqual([]);
		expect(json([]).version).toBe('https://jsonfeed.org/version/1.1');
	});
});

describe('what the feed calls itself', () => {
	it('is the configured title when there is one', () => {
		expect(titleFrom('Bleichi Loveless', 'example.com')).toBe('Bleichi Loveless');
	});

	it('is derived from the host when there is not', () => {
		// A feed must have a title to be valid, and an installation nobody has named should still
		// publish a valid one.
		expect(titleFrom(undefined, 'bleichi.live')).toBe('bleichi.live — posts');
	});

	it('is never empty, even with no host to go on', () => {
		expect(titleFrom(undefined, '')).toBe('Posts');
	});
});
