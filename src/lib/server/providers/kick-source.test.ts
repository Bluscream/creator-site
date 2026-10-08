/**
 * The Kick source.
 *
 * Split deliberately, because the two halves earn trust differently.
 *
 * `handleOf`, `secondsOf` and `thumbnailOf` carry no network and are tested unconditionally. That is
 * where this provider's own judgement lives — which spellings of a channel name to accept, which
 * field actually holds the date, which thumbnail to prefer — and it is the part that can be wrong
 * without any platform changing.
 *
 * The rest runs the **real published Kick plugin** against the **real Kick**, because this
 * provider's remaining job is translating what that plugin returns, and a stub of it would assert
 * only what this file imagines it returns. That is exactly the mistake that produced a corrupt `id`
 * on every post upstream: a shape check written from imagination passed while real data was mangled.
 *
 * So that half is opt-in behind `RUN_LIVE=1`. It reaches two third parties, and a suite that does
 * that quietly on every `npm test` is a bad citizen — and it breaks when upstream changes the
 * plugin, which is a real risk of this kind of source and better surfaced than hidden.
 */

import { describe, expect, it } from 'vitest';
import { handleOf, kickSourceProvider, secondsOf, thumbnailOf } from './kick-source.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

const SOURCE: ResolvedSource = {
	id: 'kick',
	kind: 'kick',
	target: 'xqc',
	label: 'Kick',
	platform: 'kick'
};

describe('the channel a source names', () => {
	it.each([
		['a bare handle', 'xqc', 'xqc'],
		['a handle with an at sign', '@xqc', 'xqc'],
		['surrounding space', '  xqc  ', 'xqc'],
		['a bare url', 'kick.com/xqc', 'xqc'],
		['a full url', 'https://kick.com/xqc', 'xqc'],
		['a url with a trailing path', 'https://kick.com/xqc/videos', 'xqc'],
		['a url with a query', 'https://kick.com/xqc?ref=x', 'xqc'],
		['a www url', 'https://www.kick.com/xqc', 'xqc'],
		['underscores, which Kick allows', 'some_body', 'some_body']
	])('reads %s', (_name, target, expected) => {
		// All three spellings are what somebody actually has to hand, and rejecting two of them would
		// be a configuration error for no reason.
		expect(handleOf(target)).toBe(expected);
	});

	it.each([
		['an empty string', ''],
		['a single character, which Kick does not issue', 'a'],
		['a handle with a dot', 'some.body'],
		['a handle with a slash', 'a/b/c'],
		['another platform', 'https://twitch.tv/xqc'],
		// The one that matters: a host merely *containing* kick.com is not Kick.
		['a lookalike host', 'https://kick.com.evil.example/xqc'],
		['a url with no channel in it', 'https://kick.com/'],
		['nonsense', 'not a url at all']
	])('refuses %s', (_name, target) => {
		expect(handleOf(target)).toBeNull();
	});

	it('reports an unusable source before any request is made', () => {
		expect(kickSourceProvider.unusable({ ...SOURCE, target: 'not valid!' })).toContain('kick.com');
		expect(kickSourceProvider.unusable(SOURCE)).toBeNull();
	});
});

describe('the date, which is not where the interface says', () => {
	it('reads uploadDate when datetime is zero', () => {
		// Exactly what a real Kick video looks like. Reading only `datetime` dates every post to 1970,
		// which sorts the whole source to the bottom of a merged feed and reads as a broken site.
		expect(secondsOf({ datetime: 0, uploadDate: 1_791_392_283 })).toBe(1_791_392_283);
	});

	it('prefers datetime when it has one', () => {
		expect(secondsOf({ datetime: 1_700_000_000, uploadDate: 1_791_392_283 })).toBe(1_700_000_000);
	});

	it('accepts either as a string, because plugins are not typed', () => {
		expect(secondsOf({ uploadDate: '1791392283' })).toBe(1_791_392_283);
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
						{ url: 'https://images.kick.com/a/360', quality: 360 },
						{ url: 'https://images.kick.com/a/1080', quality: 1080 },
						{ url: 'https://images.kick.com/a/720', quality: 720 }
					]
				}
			})
		).toBe('https://images.kick.com/a/1080');
	});

	it('keeps an unlabelled source rather than dropping the picture', () => {
		// Several plugins emit one url with no quality at all, and discarding it costs the image for
		// no gain.
		expect(thumbnailOf({ thumbnails: { sources: [{ url: 'https://images.kick.com/a' }] } })).toBe(
			'https://images.kick.com/a'
		);
	});

	it.each([
		['no thumbnails at all', {}],
		['a null thumbnails', { thumbnails: null }],
		['sources that is not an array', { thumbnails: { sources: 'https://x.test/a' } }],
		['an empty sources', { thumbnails: { sources: [] } }],
		['entries with no url', { thumbnails: { sources: [{ quality: 720 }] } }],
		['a null entry', { thumbnails: { sources: [null] } }],
		// A url the plugin corrupted, or one pointing somewhere a page must not load from.
		['a non-http url', { thumbnails: { sources: [{ url: 'javascript:alert(1)' }] } }],
		[
			'a character-indexed object, which is what a host bug produced',
			{
				thumbnails: { sources: [{ 0: 'h', 1: 't', url: undefined }] }
			}
		]
	])('reports none for %s', (_name, video) => {
		expect(thumbnailOf(video)).toBeUndefined();
	});
});

/**
 * The real plugin against the real platform.
 *
 * Nothing is faked here: the plugin's manifest and script come from Kick's published url, and the
 * plugin's own requests go to Kick. That is the point — it is the only arrangement that can say
 * whether this reader works today.
 *
 * The cost is honest too: it fails when Kick changes, when the plugin changes, and when the network
 * is unavailable. That is why it is opt-in rather than part of the ordinary gate.
 */
const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

live('reading a channel through the real plugin', () => {
	/**
	 * The provider contract's fetch, as thinly as possible.
	 *
	 * Not a stub: it forwards to the real network. It exists because `SourceContext.fetch` is the
	 * seam this provider is required to use, and it is what the orchestrator supplies in production —
	 * so routing through it here is part of what is being tested.
	 */
	function context(): SourceContext {
		return {
			fetch: (url, init) =>
				fetch(url, {
					...(init?.method === undefined ? {} : { method: init.method }),
					...(init?.headers === undefined ? {} : { headers: init.headers }),
					...(init?.body === undefined ? {} : { body: init.body })
				}),
			store: {
				get: () => Promise.resolve(null),
				put: () => Promise.resolve()
			}
		};
	}

	it('turns a real feed into posts with every field a row needs', async () => {
		const posts = await kickSourceProvider.read(SOURCE, context());

		expect(posts.length).toBeGreaterThan(0);

		for (const post of posts) {
			// The assertions that would have caught the host bug this provider was written against:
			// a corrupt id, author or thumbnail serialises perfectly well and carries nothing, so
			// each is checked for content rather than for being present.
			expect(post.url).toMatch(/^https:\/\/kick\.com\//);
			expect(post.title.length).toBeGreaterThan(0);
			expect(post.id).not.toBe('');
			expect(post.author?.name).toBeTruthy();
			expect(post.kind).toBe('video');

			// `at` is nullable on the canonical type, but this reader drops a post without a date
			// rather than passing one through — so here it is always a real one.
			expect(post.at).not.toBeNull();
			expect(new Date(String(post.at)).getUTCFullYear()).toBeGreaterThan(2015);

			for (const item of post.media) {
				expect(item.url).toMatch(/^https:\/\//);
			}
		}

		// Newest first is the orchestrator's job, but the dates have to be real for it to work.
		expect(posts.every((post) => Number.isFinite(Date.parse(String(post.at))))).toBe(true);

		// At least one picture across the whole page. Every post individually may lack one, but a
		// reader that silently produced none would mean the thumbnail mapping is broken.
		expect(posts.some((post) => post.media.length > 0)).toBe(true);
	}, 180_000);

	it('says the channel could not be read rather than leaking the plugin message', async () => {
		// A handle that is valid in shape and holds no channel. The message is what an admin sees,
		// so it must name the platform and not quote a url with anything in it.
		const failure = await kickSourceProvider
			.read({ ...SOURCE, target: 'zzz_no_such_kick_channel_zz' }, context())
			.then(() => null)
			.catch((cause: unknown) => cause);

		expect(failure).not.toBeNull();
		expect((failure as Error).message).toMatch(/Kick/);
		expect((failure as Error).message).not.toMatch(/https?:\/\//);
	}, 180_000);
});
