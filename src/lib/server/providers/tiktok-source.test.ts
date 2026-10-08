/**
 * That a TikTok embed page becomes posts.
 *
 * The fixture is a trimmed copy of a real `tiktok.com/embed/@handle` response: the same state
 * container, the same field names, and the same three ids pinned ahead of the chronological ones,
 * because that ordering is a thing this reader exists to correct.
 */

import { describe, expect, it } from 'vitest';
import { handleOf, pageOf, postedAt, stateIn, tiktokSourceProvider } from './tiktok-source.js';
import { memoryStore } from '#lib/server/fixtures/source-context.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { SourceContext } from './posts-source.js';

const source: ResolvedSource = {
	id: 'tiktok',
	kind: 'tiktok',
	target: '@someone',
	label: 'TikTok',
	platform: 'tiktok'
};

/** Ids from the live page: three pinned from 2025, then two from 2026. */
const NEWEST = '7691691649507839265'; // 2026-10-01
const NEWER = '7690519928155163937'; // 2026-09-28
const PINNED = '7533347163263290646'; // 2025-07-31

/** One video entry, with the fields the page actually carries. */
function video(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		desc: 'Welcome back to the otterspace\n#comeback #vrchat',
		height: 1024,
		width: 576,
		ratio: '540p',
		coverUrl: `https://p16-common-sign.tiktokcdn-eu.com/${id}.image?x-expires=1791550800`,
		originCoverUrl: `https://p16-common-sign.tiktokcdn-eu.com/${id}-origin.image`,
		playAddr: `https://v16m.tiktokcdn-eu.com/${id}/video.mp4`,
		playCount: 3464,
		privateItem: false,
		authorUniqueId: 'someone',
		...overrides
	};
}

/** A whole embed page, as the state blob inside an HTML document. */
function embed(
	videoList: readonly unknown[],
	userInfo: unknown = { uniqueId: 'someone', nickname: 'Someone' }
) {
	const state = {
		theme: { langs: ['en'] },
		frontity: { packages: [] },
		source: {
			data: {
				// Other routes are present in the real state and carry no video list.
				'/': { isReady: true, route: '/' },
				'/embed/@someone': { isReady: true, link: '/embed/@someone', userInfo, videoList }
			}
		}
	};

	return `<!DOCTYPE html><html><head><title>TikTok</title></head><body><div id="app"></div><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state)}</script></body></html>`;
}

/** A context answering with a page body, recording the urls asked for. */
function answering(body: string, status = 200): SourceContext & { readonly urls: string[] } {
	const urls: string[] = [];

	return {
		urls,
		store: memoryStore(),
		fetch: (url: string) => {
			urls.push(url);

			return Promise.resolve(
				new Response(body, { status, headers: { 'content-type': 'text/html' } })
			);
		}
	};
}

describe('reading an account’s videos', () => {
	it('asks the embed page for the handle', async () => {
		const context = answering(embed([video(NEWEST)]));

		await tiktokSourceProvider.read(source, context);

		expect(context.urls).toStrictEqual(['https://www.tiktok.com/embed/@someone']);
	});

	it('maps a video', async () => {
		const [post] = await tiktokSourceProvider.read(source, answering(embed([video(NEWEST)])));

		expect(post).toStrictEqual({
			id: `tiktok:${NEWEST}`,
			source: 'tiktok',
			platform: 'tiktok',
			title: 'Welcome back to the otterspace',
			url: `https://www.tiktok.com/@someone/video/${NEWEST}`,
			body: 'Welcome back to the otterspace #comeback #vrchat',
			media: [
				{
					url: `https://p16-common-sign.tiktokcdn-eu.com/${NEWEST}.image?x-expires=1791550800`,
					kind: 'image'
				}
			],
			kind: 'video',
			at: '2026-10-01T13:31:57.000Z',
			duration: null,
			views: null,
			live: false,
			author: { name: 'Someone' }
		});
	});

	it('puts a pinned video where its date says, not where TikTok listed it', async () => {
		// The live page returned three videos from 2025 ahead of nine from 2026, and nothing in the
		// payload marks one as pinned — so the derived date is the only thing that can fix the order.
		const posts = await tiktokSourceProvider.read(
			source,
			answering(embed([video(PINNED), video(NEWEST), video(NEWER)]))
		);

		expect(posts.map((post) => post.id)).toStrictEqual([
			`tiktok:${NEWEST}`,
			`tiktok:${NEWER}`,
			`tiktok:${PINNED}`
		]);
	});

	it('finds the video list without knowing the route key', async () => {
		// The state is keyed by route, so a differently-cased or redirected handle changes the key.
		const html = embed([video(NEWEST)]).replace('/embed/@someone', '/embed/@SomeOne');
		const posts = await tiktokSourceProvider.read(source, answering(html));

		expect(posts).toHaveLength(1);
	});

	it('links to the account the page names, not the one that was configured', async () => {
		// So a renamed account's links keep working off whatever the page itself says.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { authorUniqueId: 'renamed' })]))
		);

		expect(post?.url).toBe(`https://www.tiktok.com/@renamed/video/${NEWEST}`);
	});

	it('falls back to the handle when the page has no display name', async () => {
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST)], { uniqueId: 'someone' }))
		);

		expect(post?.author?.name).toBe('someone');
	});

	it('leaves out a private video, whose page nobody can open', async () => {
		const posts = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { privateItem: true }), video(NEWER)]))
		);

		expect(posts.map((post) => post.id)).toStrictEqual([`tiktok:${NEWER}`]);
	});

	it('leaves out a video it cannot date, rather than sinking it to the end', async () => {
		const posts = await tiktokSourceProvider.read(
			source,
			answering(embed([video('not-a-snowflake'), video(NEWER)]))
		);

		expect(posts.map((post) => post.id)).toStrictEqual([`tiktok:${NEWER}`]);
	});

	it('does not link to the video file, which is what playAddr is', async () => {
		const [post] = await tiktokSourceProvider.read(source, answering(embed([video(NEWEST)])));

		expect(post?.url).not.toContain('v16m');
		expect(post?.media[0]?.url).not.toContain('v16m');
	});

	it('is empty, not broken, for an account with no videos', async () => {
		expect(await tiktokSourceProvider.read(source, answering(embed([])))).toStrictEqual([]);
	});
});

describe('the date in a video id', () => {
	it('is the top 32 bits, as seconds', () => {
		expect(postedAt(NEWEST)).toBe('2026-10-01T13:31:57.000Z');
	});

	it('survives an id larger than a JavaScript number', () => {
		// The whole reason this uses BigInt. The id does not survive `Number` — and it cannot be
		// written as a numeric literal here either, because the literal would be rounded the same
		// way, which is how precision loss this size hides.
		expect(String(Number(NEWEST))).not.toBe(NEWEST);

		expect(new Set([postedAt(NEWEST), postedAt(NEWER), postedAt(PINNED)]).size).toBe(3);
	});

	it('is not what the obvious shift would give', () => {
		// The actual trap, and not the one it looks like. Losing the low bits to `Number` does not
		// move the date, because the timestamp lives in the *high* 32 bits. What breaks is the shift:
		// `>>` coerces its operand to Int32 and masks the shift count to five bits, so `>> 32` is
		// `>> 0` — the obvious one-liner returns a wrapped remnant of the id and calls it a date.
		const obvious = Number(NEWEST) >> 32;

		expect(obvious).not.toBe(Number(BigInt(NEWEST) >> 32n));
		expect(postedAt(NEWEST)).not.toBe(new Date(obvious * 1000).toISOString());
	});

	it.each([
		['a non-numeric id', 'abc'],
		['an empty id', ''],
		['an id with punctuation', '7691691649507839265x'],
		// 1 shifted right 32 is 0, which is 1970 — a date, but not a real one.
		['an id too small to hold a timestamp', '1'],
		['an id whose timestamp is in the far future', '99999999999999999999']
	])('is null for %s', (_case, id) => {
		expect(postedAt(id)).toBeNull();
	});
});

describe('the handle a target names', () => {
	it.each([
		['a bare handle', 'someone', 'someone'],
		['an @handle', '@someone', 'someone'],
		['a handle with a dot', '@some.one', 'some.one'],
		['a profile url', 'https://www.tiktok.com/@someone', 'someone'],
		['a video url', 'https://www.tiktok.com/@someone/video/7691691649507839265', 'someone'],
		['mixed case, normalised', '@SomeOne', 'someone']
	])('reads %s', (_case, target, expected) => {
		expect(handleOf(target)).toBe(expected);
	});

	it.each([
		['nothing', ''],
		['a single character, below the minimum', 'a'],
		['a handle with a space', 'some one'],
		['a handle with a hyphen, which TikTok does not allow', 'some-one'],
		['a url with no handle in it', 'https://www.tiktok.com/foryou'],
		['something that is not a url at all', 'https://']
	])('refuses %s', (_case, target) => {
		expect(handleOf(target)).toBeNull();
	});
});

describe('reading the state out of the page', () => {
	it('finds it', () => {
		expect(pageOf(stateIn(embed([video(NEWEST)])))).not.toBeNull();
	});

	it('is null when the script tag is absent', () => {
		expect(stateIn('<html><body>nothing here</body></html>')).toBeNull();
	});

	it('is null when the script tag holds something that is not JSON', () => {
		const html = '<script id="__FRONTITY_CONNECT_STATE__">not json</script>';

		expect(stateIn(html)).toBeNull();
	});

	it('is null when no route carries a video list', () => {
		expect(pageOf({ source: { data: { '/': { isReady: true } } } })).toBeNull();
	});

	it('is null for a shape it has never seen', () => {
		expect(pageOf('a string')).toBeNull();
		expect(pageOf(null)).toBeNull();
	});
});

describe('when the page cannot be read', () => {
	it('reports the status', async () => {
		await expect(tiktokSourceProvider.read(source, answering('', 503))).rejects.toThrow(
			/answered 503/
		);
	});

	it('says which two things an unreadable page could mean', async () => {
		// A missing account and a changed page look identical from here, and one of them is something
		// the admin can fix — so the message names both rather than guessing.
		await expect(
			tiktokSourceProvider.read(source, answering('<html><body>404</body></html>'))
		).rejects.toThrow(/may not exist, or TikTok may have changed/);
	});

	it('fails the source rather than the feed', async () => {
		await expect(
			tiktokSourceProvider.read(source, answering('<html></html>'))
		).rejects.toBeInstanceOf(SourceFailure);
	});
});

describe('deciding whether a source is usable', () => {
	it('accepts a handle', () => {
		expect(tiktokSourceProvider.unusable(source)).toBeNull();
	});

	it('shows the shape of a target rather than only refusing', () => {
		expect(tiktokSourceProvider.unusable({ ...source, target: 'a' })).toMatch(/@handle/);
	});
});
