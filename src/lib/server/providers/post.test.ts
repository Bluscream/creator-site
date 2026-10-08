/**
 * That whatever a platform returned becomes the one shape the UI draws.
 *
 * Everything here is a pure function, and every case is one a real platform actually produces —
 * the ones worth testing are the ones where the obvious implementation is subtly wrong, so most of
 * these assert a boundary rather than a happy path.
 */

import { describe, expect, it } from 'vitest';
import {
	buildPost,
	excerpt,
	headline,
	image,
	plain,
	resolveSource,
	sourceCacheKey,
	when
} from './post.js';
import type { ResolvedSource } from './post.js';

const source: ResolvedSource = {
	id: 'youtube',
	kind: 'youtube',
	target: '@someone',
	label: 'YouTube',
	platform: 'youtube'
};

describe('resolving a configured source', () => {
	it('detects the platform from the entry itself', () => {
		const resolved = resolveSource({
			id: 'yt',
			kind: 'youtube',
			url: '@someone',
			platform: 'youtube',
			hidden: false
		});

		expect(resolved.platform).toBe('youtube');
		expect(resolved.label).toBe('YouTube');
	});

	it('detects the platform from the url when the entry does not say', () => {
		const resolved = resolveSource({
			id: 'videos',
			kind: 'feed',
			url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc',
			hidden: false
		});

		expect(resolved.platform).toBe('youtube');
	});

	it('falls back to the id when the url gives nothing away', () => {
		const resolved = resolveSource({
			id: 'twitch',
			kind: 'twitch',
			url: 'someone',
			hidden: false
		});

		expect(resolved.platform).toBe('twitch');
	});

	it('prefers an explicit label over the platform name', () => {
		const resolved = resolveSource({
			id: 'yt',
			kind: 'youtube',
			url: '@someone',
			platform: 'youtube',
			label: 'My videos',
			hidden: false
		});

		expect(resolved.label).toBe('My videos');
	});

	it('labels an unknown platform from its id', () => {
		const resolved = resolveSource({
			id: 'blog',
			kind: 'feed',
			url: 'https://example.com/feed.xml',
			hidden: false
		});

		expect(resolved).toMatchObject({ platform: null, label: 'Blog' });
	});
});

describe('where a source is cached', () => {
	it('ignores the id, so renaming a source keeps its posts', () => {
		const renamed = { ...source, id: 'yt-videos', label: 'Videos' };

		expect(sourceCacheKey(renamed)).toBe(sourceCacheKey(source));
	});

	it('changes when the target does, so repointing starts cold', () => {
		expect(sourceCacheKey({ ...source, target: '@someone-else' })).not.toBe(sourceCacheKey(source));
	});

	it('changes when the kind does, for the same target', () => {
		expect(sourceCacheKey({ ...source, kind: 'feed' })).not.toBe(sourceCacheKey(source));
	});

	it('cannot collide across the kind and target boundary', () => {
		// `feed` + `a-b` against a kind ending in `-a` with target `b`: the same string if the two
		// parts were joined with a hyphen, which is what the separator is for.
		expect(sourceCacheKey({ ...source, kind: 'feed', target: 'a-b' })).not.toBe(
			sourceCacheKey({ ...source, kind: 'feed', target: 'a\0b' })
		);
	});
});

describe('building a post', () => {
	it('prefixes the id with the source, so two platforms cannot collide', () => {
		expect(buildPost(source, { id: '12345', url: 'https://example.com/a' })?.id).toBe(
			'youtube:12345'
		);
	});

	it('refuses a post with no link', () => {
		expect(buildPost(source, { id: '1', url: null })).toBeNull();
	});

	it('refuses a link that is not http, which a row could not open', () => {
		// A row with nowhere to go looks like content and does nothing, which is worse than no row.
		expect(buildPost(source, { id: '1', url: 'javascript:alert(1)' })).toBeNull();
		expect(buildPost(source, { id: '1', url: 'data:text/html,x' })).toBeNull();
		expect(buildPost(source, { id: '1', url: '/relative' })).toBeNull();
	});

	it('gives an absent title an empty string rather than null', () => {
		// The row renders the excerpt in that case; a null would have to be handled by every caller.
		expect(buildPost(source, { id: '1', url: 'https://example.com/a' })?.title).toBe('');
	});

	it('carries the source and platform onto every post', () => {
		expect(buildPost(source, { id: '1', url: 'https://example.com/a' })).toMatchObject({
			source: 'youtube',
			platform: 'youtube'
		});
	});
});

/**
 * Duration, view count and live.
 *
 * Borrowed from GrayJay's `PlatformVideo` after comparing the two models field by field. The
 * platforms send these inconsistently — a clip's duration is a float, a view count is often absent
 * — and the failure mode of getting it wrong is `NaN`, which is worse than it looks: it reaches a
 * cache file as the JSON literal `null` and comes back failing the parser, a long way from the
 * provider that produced it.
 */
describe('a count the platform may or may not have sent', () => {
	/** A raw post that is otherwise minimal, built. */
	const built = (raw: Partial<Parameters<typeof buildPost>[1]>) =>
		buildPost(source, { id: '1', url: 'https://example.com/a', ...raw });

	it('is null when the platform said nothing', () => {
		expect(built({})).toMatchObject({ duration: null, views: null, live: false });
	});

	it('keeps a real count', () => {
		expect(built({ duration: 3723, views: 1863 })).toMatchObject({ duration: 3723, views: 1863 });
	});

	it('keeps zero, which is a real number', () => {
		// Distinct from null: a video with no views, and a platform that publishes no counts, are
		// different facts — and a `?? 0` at some callsite would merge them.
		expect(built({ views: 0 })?.views).toBe(0);
	});

	it('rounds a fractional duration, as a clip sends', () => {
		expect(built({ duration: 28.4 })?.duration).toBe(28);
	});

	it('refuses NaN rather than storing it', () => {
		expect(built({ duration: Number.NaN, views: Number.NaN })).toMatchObject({
			duration: null,
			views: null
		});
	});

	it('refuses infinity and a negative count', () => {
		expect(built({ duration: Number.POSITIVE_INFINITY })?.duration).toBeNull();
		expect(built({ views: -5 })?.views).toBeNull();
	});

	it('is live only when the platform says so', () => {
		expect(built({ live: true })?.live).toBe(true);
		expect(built({ live: false })?.live).toBe(false);
	});
});

describe('plain text', () => {
	it('collapses every kind of whitespace run into one space', () => {
		expect(plain('a \t\n  b\r\nc')).toBe('a b c');
	});

	it('is null in, null out', () => {
		expect(plain(null)).toBeNull();
		expect(plain(undefined)).toBeNull();
	});

	it('leaves an entity alone, because the parser already decoded one layer', () => {
		// Decoding again would turn a literal ampersand in somebody's title into markup, and that
		// is not recoverable. The feed parser decodes while parsing; this must not decode twice.
		expect(plain('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
	});
});

describe('an excerpt', () => {
	it('is empty rather than null when there is nothing', () => {
		expect(excerpt(null)).toBe('');
		expect(excerpt('   ')).toBe('');
	});

	it('strips markup, which a feed description routinely contains', () => {
		expect(excerpt('<p>Hello <b>there</b></p>')).toBe('Hello there');
	});

	it('leaves a short text exactly as it is', () => {
		expect(excerpt('Short enough.')).toBe('Short enough.');
	});

	it('cuts on a word boundary near the limit', () => {
		const text = `${'word '.repeat(50)}end`;
		const cut = excerpt(text);

		expect(cut.endsWith('…')).toBe(true);
		expect(cut).not.toMatch(/wor…$/);
	});

	it('does not cut back to one word when the only space is early', () => {
		// A single long run with its last space at position 1. Cutting on that boundary would throw
		// away 218 characters to avoid breaking a word, so the mid-word cut is the right answer.
		const cut = excerpt(`a ${'x'.repeat(400)}`);

		expect(cut.length).toBeGreaterThan(200);
	});

	it('never splits a character made of two code units', () => {
		// A wall of emoji is most of what a social post is. Counting UTF-16 units would cut one in
		// half and leave a lone surrogate.
		//
		// The single leading character is load-bearing. Without it the emoji start at unit 0 and the
		// limit — an even number — lands exactly between two of them, so a broken implementation
		// passes by luck. One ASCII character shifts every pair onto an odd boundary, which is what
		// makes the cut land inside one. A first version of this test had no prefix and did not
		// catch the defect when it was planted.
		const cut = excerpt(`a${'🦦'.repeat(300)}`);

		expect(cut).not.toMatch(/[\uD800-\uDFFF]/u);
		expect(cut.endsWith('…')).toBe(true);
	});

	it('never splits a character built out of several emoji', () => {
		// The case counting code points gets wrong: a family is one grapheme cluster made of three
		// emoji joined by zero-width joiners. Cutting between them does not produce a broken
		// character — it produces a man, a woman and a girl, which reads as different content
		// rather than as damage, and is therefore the worse failure.
		const family = '👨‍👩‍👧';
		const cut = excerpt(family.repeat(200));

		// Every joiner that survives must still be between two people: no cluster was left dangling
		// on a joiner, and none was cut down to a lone person.
		expect(cut).not.toMatch(/‍…$/u);
		expect(cut.replaceAll(family, '').replace('…', '')).toBe('');
	});
});

describe('a stand-in title', () => {
	it('is the first line only, because a heading is one line', () => {
		expect(headline('One\nTwo\nThree')).toBe('One');
	});

	it('is empty for nothing, rather than a word a translation could not reach', () => {
		expect(headline('')).toBe('');
		expect(headline('\n\n')).toBe('');
		expect(headline(null)).toBe('');
		expect(headline(undefined)).toBe('');
	});

	it('is the whole line when the line is short', () => {
		expect(headline('A post about otters')).toBe('A post about otters');
	});

	it('is cut when the first line is a paragraph', () => {
		const cut = headline('word '.repeat(60));

		expect(cut.endsWith('…')).toBe(true);

		// Counted the same way the cut counts: 89 words' worth of clusters kept, the trailing space
		// trimmed, then the ellipsis.
		const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cut)];

		expect(clusters).toHaveLength(90);
	});

	it('does not cut an emoji in half', () => {
		// The prefix is load-bearing: a whole string of otters is an even number of UTF-16 units, so
		// a cut by code unit would land on a boundary by luck and a broken implementation would pass.
		const cut = headline(`x${'🦦'.repeat(200)}`);

		expect(cut).not.toMatch(/[\uD800-\uDFFF]…$/u);
	});

	it('does not cut a family into its members', () => {
		// Counting code points rather than clusters splits this into a man, a woman and a girl —
		// which renders as different content rather than as damage, so it is the worse failure.
		const family = '👨‍👩‍👧';
		const cut = headline(`x${family.repeat(100)}`);

		expect(cut.replace('x', '').replaceAll(family, '').replace('…', '')).toBe('');
	});
});

describe('an image url', () => {
	it('accepts https', () => {
		expect(image('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
	});

	it('drops http, which the browser would refuse as mixed content anyway', () => {
		expect(image('http://example.com/a.jpg')).toBeNull();
	});

	it('drops anything with whitespace or a quote in it', () => {
		expect(image('https://example.com/a .jpg')).toBeNull();
		expect(image('https://example.com/"a.jpg')).toBeNull();
	});

	it('is null for an absent one', () => {
		expect(image(null)).toBeNull();
		expect(image(undefined)).toBeNull();
	});
});

describe('a timestamp', () => {
	it('normalises to UTC, whatever offset it arrived with', () => {
		expect(when('2026-10-06T13:34:44+02:00')).toBe('2026-10-06T11:34:44.000Z');
	});

	it('reads the RFC 3339 that Twitch emits', () => {
		expect(when('2026-10-06T11:34:44Z')).toBe('2026-10-06T11:34:44.000Z');
	});

	it('is null for something unparseable, rather than the epoch', () => {
		// The merged list sorts on this string. A failed parse becoming 1970 would move the post to
		// the bottom and look deliberate; null sorts last and says "undated".
		expect(when('next tuesday')).toBeNull();
		expect(when('')).toBeNull();
		expect(when(null)).toBeNull();
	});
});
