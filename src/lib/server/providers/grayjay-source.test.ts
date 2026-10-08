/**
 * The shared GrayJay reader.
 *
 * Split the same way as `kick-source.test.ts`, and for the same reason. The routing and translation
 * carry no network and are tested unconditionally; the claim that each plugin in {@link PLUGINS}
 * actually works is tested against the real plugins behind `RUN_LIVE=1`, because that claim is the
 * whole value of the table and nothing offline can support it.
 */

import { describe, expect, it } from 'vitest';
import {
	PLUGINS,
	grayjaySourceProvider,
	nameOf,
	pluginFor,
	secondsOf,
	thumbnailOf,
	toPost
} from './grayjay-source.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

const SOURCE: ResolvedSource = {
	id: 'dm',
	kind: 'grayjay',
	target: 'https://www.dailymotion.com/channel',
	label: 'Dailymotion',
	platform: null
};

describe('choosing a plugin for a target', () => {
	it.each([
		['a full url', 'https://www.dailymotion.com/someone', 'Dailymotion'],
		['no scheme', 'odysee.com/@someone', 'Odysee'],
		['a bare host', 'soundcloud.com/someone', 'SoundCloud'],
		['a subdomain', 'https://www.bitchute.com/channel/x', 'Bitchute'],
		['a host that is an exact entry', 'https://media.ccc.de/b/conferences/x', 'media.ccc.de'],
		['mixed case', 'HTTPS://WWW.NEBULA.TV/someone', 'Nebula']
	])('matches %s', (_name, target, expected) => {
		expect(pluginFor(target)?.name).toBe(expected);
	});

	it.each([
		['a platform with no plugin here', 'https://example.com/someone'],
		// Rumble's plugin needs HttpImp, so it is deliberately not in the table — see the note there.
		['a platform whose plugin cannot run on Node', 'https://rumble.com/c/someone'],
		['a lookalike host', 'https://odysee.com.evil.example/x'],
		['a suffix without the dot boundary', 'https://notodysee.com/x'],
		['an empty string', ''],
		['nonsense', 'not a url at all']
	])('refuses %s', (_name, target) => {
		expect(pluginFor(target)).toBeNull();
	});

	it('tells an admin which platforms it can read', () => {
		// Not merely "unsupported": the list is the actionable part, and it is generated from the
		// table so it cannot drift from what is actually registered.
		const reason = grayjaySourceProvider.unusable({ ...SOURCE, target: 'https://example.com/x' });

		expect(reason).toContain('Dailymotion');
		expect(reason).toContain('SoundCloud');
		expect(grayjaySourceProvider.unusable(SOURCE)).toBeNull();
	});

	it('names every plugin exactly once and gives each at least one host', () => {
		// A duplicate host would make which plugin reads it depend on table order, which is not
		// something a reader should decide by accident.
		const hosts = PLUGINS.flatMap((plugin) => plugin.hosts);

		expect(new Set(PLUGINS.map((plugin) => plugin.name)).size).toBe(PLUGINS.length);
		expect(new Set(hosts).size).toBe(hosts.length);
		expect(PLUGINS.every((plugin) => plugin.hosts.length > 0)).toBe(true);
		expect(PLUGINS.every((plugin) => plugin.manifest.startsWith('https://'))).toBe(true);
	});
});

describe('the date, which is not where the interface says', () => {
	it('reads uploadDate when datetime is zero', () => {
		// What a real Kick video looks like. Reading only the documented field dates every post to
		// 1970, which sorts the source to the bottom of a merged feed and reads as a broken site.
		expect(secondsOf({ datetime: 0, uploadDate: 1_791_392_283 })).toBe(1_791_392_283);
	});

	it('prefers datetime when it has one', () => {
		expect(secondsOf({ datetime: 1_700_000_000, uploadDate: 1_791_392_283 })).toBe(1_700_000_000);
	});

	it('accepts a string, because plugins are not typed', () => {
		expect(secondsOf({ uploadDate: '1791392283' })).toBe(1_791_392_283);
	});

	it('converts milliseconds, which some plugins send', () => {
		// Trusting a millisecond value as seconds dates a post tens of thousands of years out, which
		// sorts it permanently to the top of the feed — the most visible possible way to be wrong.
		expect(secondsOf({ datetime: 1_791_392_283_000 })).toBe(1_791_392_283);
	});

	it.each([
		['neither field', {}],
		['both zero', { datetime: 0, uploadDate: 0 }],
		['a negative value', { datetime: -5 }],
		['not a number', { uploadDate: 'the other day' }],
		['null', { datetime: null }],
		['NaN', { datetime: Number.NaN }],
		['infinity', { datetime: Number.POSITIVE_INFINITY }]
	])('reports no date for %s', (_name, video) => {
		expect(secondsOf(video)).toBeNull();
	});
});

describe('the thumbnail', () => {
	it('takes the highest quality offered', () => {
		expect(
			thumbnailOf({
				thumbnails: {
					sources: [
						{ url: 'https://cdn.test/360', quality: 360 },
						{ url: 'https://cdn.test/1080', quality: 1080 },
						{ url: 'https://cdn.test/720', quality: 720 }
					]
				}
			})
		).toBe('https://cdn.test/1080');
	});

	it('keeps an unlabelled source rather than dropping the picture', () => {
		expect(thumbnailOf({ thumbnails: { sources: [{ url: 'https://cdn.test/a' }] } })).toBe(
			'https://cdn.test/a'
		);
	});

	it.each([
		['no thumbnails at all', {}],
		['a null thumbnails', { thumbnails: null }],
		['sources that is not an array', { thumbnails: { sources: 'https://cdn.test/a' } }],
		['an empty sources', { thumbnails: { sources: [] } }],
		['entries with no url', { thumbnails: { sources: [{ quality: 720 }] } }],
		['a null entry', { thumbnails: { sources: [null] } }],
		// A url pointing somewhere a page must not load from.
		['a non-http url', { thumbnails: { sources: [{ url: 'javascript:alert(1)' }] } }]
	])('reports none for %s', (_name, video) => {
		expect(thumbnailOf(video)).toBeUndefined();
	});
});

describe('translating one item', () => {
	const ITEM = {
		id: { value: 'abc' },
		name: 'A video',
		url: 'https://www.dailymotion.com/video/x1',
		uploadDate: 1_791_392_283,
		viewCount: 42,
		duration: 90,
		isLive: false,
		author: { name: 'Someone', url: 'https://www.dailymotion.com/someone' },
		thumbnails: { sources: [{ url: 'https://cdn.test/a', quality: 720 }] }
	};

	it('carries every field a row needs', () => {
		const post = toPost(SOURCE, ITEM, { author: 'fallback' });

		expect(post).not.toBeNull();
		expect(post?.title).toBe('A video');
		expect(post?.url).toBe('https://www.dailymotion.com/video/x1');
		expect(post?.author?.name).toBe('Someone');
		expect(post?.views).toBe(42);
		expect(post?.duration).toBe(90);
		expect(post?.media[0]?.url).toBe('https://cdn.test/a');
		expect(post?.at).toBe(new Date(1_791_392_283 * 1000).toISOString());
	});

	it.each([
		['no url, because a row nobody can click is not a row', { ...ITEM, url: undefined }],
		[
			'no date, because it cannot be ordered against the other sources',
			{
				...ITEM,
				uploadDate: 0,
				datetime: 0
			}
		],
		['not an object at all', 'a string'],
		['null', null]
	])('drops an item with %s', (_name, raw) => {
		expect(toPost(SOURCE, raw, { author: 'fallback' })).toBeNull();
	});

	it('falls back to the caller author when the plugin gives none', () => {
		// A post with no author renders anonymously in a feed that merges several platforms, where
		// knowing which one it came from is most of the value.
		const post = toPost(SOURCE, { ...ITEM, author: undefined }, { author: 'fallback' });

		expect(post?.author?.name).toBe('fallback');
	});

	it('uses the plugin id when it has one and the url otherwise', () => {
		expect(toPost(SOURCE, ITEM, { author: 'x' })?.id).toContain('abc');
		expect(toPost(SOURCE, { ...ITEM, id: undefined }, { author: 'x' })?.id).toContain(
			'dailymotion.com'
		);
	});
});

describe('naming a channel from its url', () => {
	it.each([
		['https://www.dailymotion.com/someone', 'someone'],
		['https://odysee.com/@someone', '@someone'],
		['https://odysee.com/@someone/', '@someone'],
		['https://media.ccc.de/', 'media.ccc.de'],
		['not a url at all', 'not a url at all']
	])('reads %s as %s', (target, expected) => {
		expect(nameOf(target)).toBe(expected);
	});
});

/**
 * Every plugin in the table, against its real platform.
 *
 * This is the test that supports the table's only claim: that these plugins work. Each one is
 * loaded from its published url and asked for a channel's content, so it fails when a plugin is
 * updated, when a platform changes, or when a manifest url moves — all of which are real risks of
 * this kind of source and better surfaced than hidden.
 *
 * The channels are long-standing accounts, and the assertion is about *shape* rather than content:
 * a test that fails because somebody deleted a video is a test nobody trusts.
 */
const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

live('every plugin in the table', () => {
	function context(): SourceContext {
		return {
			fetch: (url, init) =>
				fetch(url, {
					...(init?.method === undefined ? {} : { method: init.method }),
					...(init?.headers === undefined ? {} : { headers: init.headers }),
					...(init?.body === undefined ? {} : { body: init.body })
				}),
			store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
		};
	}

	it.each([
		['Dailymotion', 'https://www.dailymotion.com/euronews-en'],
		['Odysee', 'https://odysee.com/@Odysee:8'],
		['SoundCloud', 'https://soundcloud.com/octobersveryown'],
		['Bitchute', 'https://www.bitchute.com/channel/bitchute/'],
		['Nebula', 'https://nebula.tv/tldrnewsglobal'],
		['media.ccc.de', 'https://media.ccc.de/c/38c3']
	])(
		'%s reads a channel',
		async (name, channel) => {
			// Loaded through the provider rather than the library, so the routing, the fetch adapter
			// and the translation are all in the path — which is what production runs.
			const posts = await grayjaySourceProvider.read(
				{ ...SOURCE, target: channel, label: name },
				context()
			);

			// At least one, not merely an array. These are long-standing, active channels, so an empty
			// result means the table is claiming something it cannot deliver — which is the one thing
			// this test exists to catch.
			expect(posts.length).toBeGreaterThan(0);

			for (const post of posts) {
				expect(post.url).toMatch(/^https?:\/\//);
				expect(post.at).not.toBeNull();
				expect(new Date(String(post.at)).getUTCFullYear()).toBeGreaterThan(2005);
				expect(post.title.length).toBeGreaterThan(0);
			}
		},
		240_000
	);
});
