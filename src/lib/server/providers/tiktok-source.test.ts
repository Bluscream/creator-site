/**
 * That a TikTok embed page becomes posts.
 *
 * The fixture is a trimmed copy of a real `tiktok.com/embed/@handle` response: the same state
 * container, the same field names, and the same three ids pinned ahead of the chronological ones,
 * because that ordering is a thing this reader exists to correct.
 */

import { describe, expect, it } from 'vitest';
import {
	expiryOf,
	handleOf,
	pageOf,
	postedAt,
	stateIn,
	tiktokSourceProvider
} from './tiktok-source.js';
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

/**
 * A context that answers the embed page and the oEmbed endpoint differently.
 *
 * Needed because the failure path asks oEmbed a second question — "does this account exist" — and a
 * stub that answered both requests identically could not tell the two diagnoses apart. Which is
 * precisely the thing worth testing: the message an admin reads depends entirely on this second
 * answer, and a stub that collapsed them would have reported the old hedge as a pass.
 */
function routing(
	embedStatus: number,
	embedBody: string,
	oembedStatus: number
): SourceContext & { readonly urls: string[] } {
	const urls: string[] = [];

	return {
		urls,
		store: memoryStore(),
		fetch: (url: string) => {
			urls.push(url);

			const oembed = url.startsWith('https://www.tiktok.com/oembed');

			return Promise.resolve(
				new Response(oembed ? '{}' : embedBody, { status: oembed ? oembedStatus : embedStatus })
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
					kind: 'image',
					expiresAt: 1791550800,
					width: 576,
					height: 1024
				}
			],
			kind: 'video',
			at: '2026-10-01T13:31:57.000Z',
			duration: null,
			views: 3464,
			live: false,
			author: { name: 'Someone', profileUrl: 'https://www.tiktok.com/@someone' }
		});
	});

	it('takes the play count, which is the only engagement number the page carries', async () => {
		// It was being parsed and dropped. `ContentPiece.views` is nullable and a renderer treats null
		// as "the platform does not say", so leaving it null here was asserting something untrue.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { playCount: 120_345 })]))
		);

		expect(post?.views).toBe(120_345);
	});

	it('takes the cover’s expiry from the cover’s own url', async () => {
		// Not from `imageTtl`, which is a lifetime assumed for the whole platform. The url states when
		// it dies, so a stale post can drop exactly the picture that has stopped working and keep the
		// rest — which is the entire reason `Media.expiresAt` exists.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(
				embed([video(NEWEST, { coverUrl: 'https://cdn.example/a.image?x-expires=1800000000' })])
			)
		);

		expect(post?.media[0]?.expiresAt).toBe(1_800_000_000);
	});

	it('leaves the expiry absent when the cover url does not carry one', async () => {
		// Absent rather than zero. A cover with no stated expiry has not expired, and a post whose
		// picture was treated as already dead would render as text for no reason.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { coverUrl: 'https://cdn.example/a.image' })]))
		);

		expect(post?.media[0]).not.toHaveProperty('expiresAt');
	});

	it('sizes the picture from the video, so a portrait row reserves the right box', async () => {
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { width: 720, height: 1280 })]))
		);

		expect(post?.media[0]?.width).toBe(720);
		expect(post?.media[0]?.height).toBe(1280);
	});

	it('gives no dimensions at all when the page states only one of them', async () => {
		// A width without a height gives a layout nothing to reserve: it would have to guess the other,
		// which is the reflow the fields exist to prevent.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { width: 720, height: undefined })]))
		);

		expect(post?.media[0]).not.toHaveProperty('width');
		expect(post?.media[0]).not.toHaveProperty('height');
	});

	it('links the author to their profile but never to their signed avatar', async () => {
		// `avatarThumbUrl` is on the page and is deliberately not taken: it is signed with an expiry
		// and `Actor` has nowhere to record one, so a cached post would hold an avatar that 404s with
		// nothing able to notice. The profile url is unsigned and permanent.
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(
				embed([video(NEWEST)], {
					uniqueId: 'someone',
					nickname: 'Someone',
					avatarThumbUrl: 'https://cdn.example/avatar.jpeg?x-expires=1800000000'
				})
			)
		);

		expect(post?.author?.profileUrl).toBe('https://www.tiktok.com/@someone');
		expect(post?.author).not.toHaveProperty('avatarUrl');
	});

	it('points the profile link at the account the page names, not the configured one', async () => {
		const [post] = await tiktokSourceProvider.read(
			source,
			answering(embed([video(NEWEST, { authorUniqueId: 'renamed' })]))
		);

		expect(post?.author?.profileUrl).toBe('https://www.tiktok.com/@renamed');
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

	it('fails the source rather than the feed', async () => {
		await expect(
			tiktokSourceProvider.read(source, answering('<html></html>'))
		).rejects.toBeInstanceOf(SourceFailure);
	});

	it('costs nothing extra when the page reads fine', async () => {
		// The diagnosis is a second request, and it must stay on the failure path. A provider that
		// asked oEmbed on every refresh would have doubled this reader's request count against an
		// endpoint that throttles — and no test of the message would have caught it.
		const context = answering(embed([video(NEWEST)]));

		await tiktokSourceProvider.read(source, context);

		expect(context.urls).toStrictEqual(['https://www.tiktok.com/embed/@someone']);
	});

	it('says the account does not exist when oEmbed says so', async () => {
		// Measured: a missing handle answers 400 from the embed page — not 404 — with a state blob that
		// parses and carries no video list, so the embed response alone cannot tell this apart from a
		// page whose shape changed. oEmbed is TikTok's own documented endpoint and answers 400 here.
		await expect(
			tiktokSourceProvider.read(source, routing(400, '<html></html>', 400))
		).rejects.toThrow(/TikTok has no account called @someone\./);
	});

	it('blames the page, not the handle, when oEmbed says the account is there', async () => {
		// The other half of the same question, and the half an admin must not be sent chasing: there is
		// nothing to fix in the configuration, so the message has to stop suggesting there is.
		await expect(
			tiktokSourceProvider.read(source, routing(200, '<html>no state</html>', 200))
		).rejects.toThrow(/although the account exists/);
	});

	it('falls back to naming both causes when oEmbed cannot be reached either', async () => {
		// The old hedge, kept for exactly this case. An unavailable diagnosis is not grounds for
		// asserting either answer, and claiming the account is missing because a second endpoint was
		// down would send an admin to delete a working source.
		await expect(tiktokSourceProvider.read(source, routing(503, '', 503))).rejects.toThrow(
			/may not exist, or TikTok may have changed/
		);
	});

	it('does not let a failed diagnosis replace the failure', async () => {
		// `diagnose` makes a request on a path that is already failing. If that request throws, the
		// throw must not escape — it would reach the orchestrator as something other than a
		// `SourceFailure`, whose message the orchestrator deliberately refuses to render.
		const context: SourceContext = {
			store: memoryStore(),
			fetch: (url: string) =>
				url.startsWith('https://www.tiktok.com/oembed')
					? Promise.reject(new Error('network is down'))
					: Promise.resolve(new Response('<html></html>', { status: 200 }))
		};

		await expect(tiktokSourceProvider.read(source, context)).rejects.toBeInstanceOf(SourceFailure);
	});
});

describe('the expiry a signed cdn url states', () => {
	it('is the x-expires query parameter', () => {
		expect(expiryOf('https://cdn.example/a.image?dr=1&x-expires=1791622800&x-signature=abc')).toBe(
			1_791_622_800
		);
	});

	it.each([
		['a url with no expiry', 'https://cdn.example/a.image'],
		['something that is not a url', 'not a url'],
		['a non-numeric expiry', 'https://cdn.example/a.image?x-expires=soon'],
		// Both ends of the plausibility window. A value outside it parsed but was not a second count
		// somebody meant, and treating it as one would drop a live picture or keep a dead one forever.
		['an expiry before TikTok existed', 'https://cdn.example/a.image?x-expires=1'],
		['an expiry implausibly far out', 'https://cdn.example/a.image?x-expires=999999999999']
	])('is undefined for %s', (_case, url) => {
		expect(expiryOf(url)).toBeUndefined();
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
