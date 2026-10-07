/**
 * That the feed's configuration schema accepts what real configuration looks like.
 *
 * The fixture below is shaped after a working installation's document — a handle target, a
 * kind-less entry, parked sources, a bridge url with a query string — rather than after the schema,
 * which is the only way this catches a schema that validates something nobody writes.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, DEFAULT_REFRESH, feedSchema } from './feed-config.js';
import { feedSources } from './feed.js';

/**
 * A representative document.
 *
 * Every entry is a case: an API-backed source whose target is a handle rather than a url, a source
 * with no `kind` at all, one parked with `hidden`, one pointed at a feed-manufacturing bridge, and
 * one that is nobody's platform.
 */
const configured = {
	enabled: true,
	limit: 40,
	sources: [
		{ id: 'tiktok', kind: 'tiktok', url: '@someone', platform: 'tiktok' },
		{ id: 'youtube', kind: 'youtube', url: '@someone', platform: 'youtube' },
		{ id: 'twitch', kind: 'twitch', url: 'someone', platform: 'twitch' },
		{ id: 'blog', url: 'https://example.com/feed.xml' },
		{
			id: 'instagram',
			hidden: true,
			kind: 'feed',
			url: 'https://bridge.example.com/?action=display&bridge=Some&context=Username&u=someone',
			platform: 'instagram'
		}
	]
};

describe('a configured feed', () => {
	const parsed = feedSchema.parse(configured);

	it('reads every entry', () => {
		expect(parsed.sources).toHaveLength(5);
	});

	it('defaults a source with no kind to an ordinary feed', () => {
		expect(parsed.sources.find((source) => source.id === 'blog')?.kind).toBe('feed');
	});

	it('keeps a hidden source in the document, so an editor can still show it', () => {
		expect(parsed.sources.find((source) => source.id === 'instagram')?.hidden).toBe(true);
	});

	it('leaves a handle target alone rather than demanding a url', () => {
		// What makes a Twitch target valid is the Twitch provider's question. Validating it as a URL
		// here would reject every API-backed source.
		expect(parsed.sources.find((source) => source.id === 'twitch')?.url).toBe('someone');
	});

	it('fills in the refresh interval it was not given', () => {
		expect(parsed.refresh).toBe(DEFAULT_REFRESH);
	});
});

describe('the sources that get fetched', () => {
	it('leave out the hidden ones', () => {
		const ids = feedSources(feedSchema.parse(configured)).map((source) => source.id);

		expect(ids).toStrictEqual(['tiktok', 'youtube', 'twitch', 'blog']);
	});

	it('keep configuration order, which is the order somebody arranged them in', () => {
		const reordered = { ...configured, sources: [...configured.sources].toReversed() };
		const ids = feedSources(feedSchema.parse(reordered)).map((source) => source.id);

		expect(ids).toStrictEqual(['blog', 'twitch', 'youtube', 'tiktok']);
	});
});

describe('an empty document', () => {
	it('is a working configuration with nothing to fetch', () => {
		expect(feedSchema.parse({})).toStrictEqual({
			enabled: true,
			limit: DEFAULT_LIMIT,
			refresh: DEFAULT_REFRESH,
			sources: []
		});
	});
});

describe('a source that cannot be used', () => {
	it.each([
		['an id with a capital letter', { id: 'YouTube', url: 'x' }],
		['an id starting with a digit', { id: '1st', url: 'x' }],
		['an id that is too long', { id: `a${'b'.repeat(40)}`, url: 'x' }],
		['no id at all', { url: 'x' }],
		['an empty target', { id: 'a', url: '   ' }],
		['no target', { id: 'a' }],
		['a kind nothing reads', { id: 'a', url: 'x', kind: 'myspace' }]
	])('is dropped: %s', (_case, entry) => {
		// Dropped rather than rejected: a half-filled row is a normal state for a file somebody is
		// editing, and it must not cost the sources that are fine.
		const parsed = feedSchema.parse({ sources: [entry, { id: 'good', url: 'https://x.test/f' }] });

		expect(parsed.sources.map((source) => source.id)).toStrictEqual(['good']);
	});
});

describe('a document with settings out of range', () => {
	it('cannot be salvaged field by field, so the caller gets defaults', () => {
		// `limit` and `refresh` have bounds and no `.catch()`, so an out-of-range value fails the
		// whole document — which `document.ts` turns into the defaults rather than an exception.
		// Asserted here so the division of labour between the two layers is explicit.
		expect(feedSchema.safeParse({ limit: 10_000 }).success).toBe(false);
		expect(feedSchema.safeParse({ refresh: 1 }).success).toBe(false);
	});

	it('accepts zero as a limit, which means no cap', () => {
		expect(feedSchema.parse({ limit: 0 }).limit).toBe(0);
	});
});
