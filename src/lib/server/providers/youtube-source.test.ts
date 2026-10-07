/**
 * That a channel can be named the ways a person actually knows it.
 *
 * The point of this provider is that nobody knows their own `UC…` id, so most of these cases are
 * the forms somebody would paste from an address bar — and the resolution ones assert that it
 * happens once rather than per refresh, against an endpoint that throttles.
 */

import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '#lib/server/fixtures/source-context.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { SourceContext } from './posts-source.js';
import { identify, youtubeSourceProvider } from './youtube-source.js';

const source: ResolvedSource = {
	id: 'youtube',
	kind: 'youtube',
	target: '@someone',
	label: 'YouTube',
	platform: 'youtube'
};

const CHANNEL = 'UChEyxtmrh1vGIfBPEyOls7Q';

/** A channel page carrying the id the way YouTube's does. */
const channelPage = `<!DOCTYPE html><html><body><script>
	var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"${CHANNEL}"}}};
</script></body></html>`;

const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
	<id>yt:video:abc</id><title>A video</title>
	<link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
	<published>2026-10-06T11:34:44+00:00</published>
</entry></feed>`;

/**
 * A context that answers the channel page for a youtube.com page and the feed for the feed url.
 *
 * Records every url, which is what lets the caching cases assert how many requests were made rather
 * than only that the right answer came back.
 */
function youtubeContext(
	options: { channelStatus?: number; channelBody?: string } = {}
): SourceContext & { readonly urls: string[] } {
	const urls: string[] = [];
	const store = memoryStore();

	return {
		urls,
		store,
		fetch: (url: string) => {
			urls.push(url);

			if (url.includes('/feeds/videos.xml')) {
				return Promise.resolve(
					new Response(feed, { headers: { 'content-type': 'application/atom+xml' } })
				);
			}

			return Promise.resolve(
				new Response(options.channelBody ?? channelPage, {
					status: options.channelStatus ?? 200,
					headers: { 'content-type': 'text/html' }
				})
			);
		}
	};
}

describe('identifying what a target is', () => {
	it.each([
		['a bare channel id', CHANNEL, { kind: 'id', value: CHANNEL }],
		['a handle with an @', '@someone', { kind: 'handle', value: '@someone' }],
		['a handle without an @', 'someone', { kind: 'handle', value: 'someone' }],
		['a handle url', 'https://www.youtube.com/@someone', { kind: 'handle', value: '@someone' }],
		['a channel url', `https://www.youtube.com/channel/${CHANNEL}`, { kind: 'id', value: CHANNEL }],
		[
			'the older /c/ form',
			'https://www.youtube.com/c/SomeName',
			{ kind: 'handle', value: 'SomeName' }
		],
		[
			'the older /user/ form',
			'https://www.youtube.com/user/SomeName',
			{ kind: 'handle', value: 'SomeName' }
		],
		[
			'a feed url, passed through',
			'https://www.youtube.com/feeds/videos.xml?channel_id=UC1',
			{ kind: 'feed', value: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1' }
		]
	])('reads %s', (_case, target, expected) => {
		expect(identify(target)).toStrictEqual(expected);
	});

	it('passes a bridged feed url through, because it need not be on youtube.com', () => {
		// Someone mirroring the feed, or putting a bridge in front of it, is a supported setup.
		const mirror = 'https://bridge.example.com/feeds/videos.xml?channel_id=UC1';

		expect(identify(mirror)).toStrictEqual({ kind: 'feed', value: mirror });
	});

	it.each([
		['nothing', ''],
		['only whitespace', '   '],
		['a watch url, which is a video and not a channel', 'https://www.youtube.com/watch?v=abc'],
		['a plain youtube.com link', 'https://www.youtube.com/'],
		['something far too short', 'ab'],
		['an insecure feed url', 'http://www.youtube.com/feeds/videos.xml?channel_id=UC1'],
		['a handle with a space in it', '@some one']
	])('refuses %s', (_case, target) => {
		expect(identify(target)).toBeNull();
	});

	it('treats a UC-looking string of the wrong length as a handle, not a bad id', () => {
		// `UCtooshort` is not a channel id, but it *is* a legal handle — ten word characters, within
		// the 3–30 YouTube allows. So it falls through to resolution, the lookup 404s, and the source
		// reports that. Refusing it here on the grounds that it looks like a malformed id would
		// reject a name somebody is allowed to have.
		expect(identify('UCtooshort')).toStrictEqual({ kind: 'handle', value: 'UCtooshort' });
	});
});

describe('deciding whether a source is usable', () => {
	it('accepts a handle', () => {
		expect(youtubeSourceProvider.unusable(source)).toBeNull();
	});

	it('explains the three things it accepts, rather than only refusing', () => {
		const reason = youtubeSourceProvider.unusable({ ...source, target: 'not a channel' });

		expect(reason).toMatch(/@handle/);
		expect(reason).toMatch(/UC/);
	});
});

describe('reading a channel', () => {
	it('resolves the handle, then reads the feed', async () => {
		const context = youtubeContext();
		const posts = await youtubeSourceProvider.read(source, context);

		expect(context.urls).toStrictEqual([
			'https://www.youtube.com/%40someone',
			`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`
		]);
		expect(posts[0]).toMatchObject({
			title: 'A video',
			url: 'https://www.youtube.com/watch?v=abc'
		});
	});

	it('skips the lookup entirely when given an id', async () => {
		const context = youtubeContext();

		await youtubeSourceProvider.read({ ...source, target: CHANNEL }, context);

		expect(context.urls).toStrictEqual([
			`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`
		]);
	});

	it('remembers a resolved handle, so a refresh costs one request and not two', async () => {
		// The reason this matters: the feed endpoint throttles by IP, so doubling the traffic to it
		// makes the throttling it answers with more likely.
		const context = youtubeContext();

		await youtubeSourceProvider.read(source, context);
		await youtubeSourceProvider.read(source, context);

		expect(context.urls.filter((url) => !url.includes('/feeds/'))).toHaveLength(1);
	});

	it('reads the id out of a channel_id link when externalId is absent', async () => {
		const context = youtubeContext({
			channelBody: `<html><link rel="alternate" href="https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}"></html>`
		});

		await youtubeSourceProvider.read(source, context);

		expect(context.urls[1]).toContain(CHANNEL);
	});
});

describe('when the lookup fails', () => {
	it('says what YouTube answered', async () => {
		const context = youtubeContext({ channelStatus: 404 });

		await expect(youtubeSourceProvider.read(source, context)).rejects.toThrow(
			/YouTube answered 404 for @someone/
		);
	});

	it('says so when the page holds no id', async () => {
		const context = youtubeContext({ channelBody: '<html><body>Nothing here</body></html>' });

		await expect(youtubeSourceProvider.read(source, context)).rejects.toBeInstanceOf(SourceFailure);
	});

	it('uses a stale stored id rather than failing', async () => {
		// A channel id never changes, so an old one is still right — and the lookup failing is most
		// often the throttling that this whole design works around.
		const good = youtubeContext();

		await youtubeSourceProvider.read(source, good);

		const broken: SourceContext & { urls: string[] } = {
			...youtubeContext({ channelStatus: 500 }),
			store: good.store
		};

		// Force the stored entry to look expired, so resolution is attempted and then fails.
		vi.spyOn(broken.store, 'get').mockResolvedValue({ value: CHANNEL, age: 999_999_999 });

		const posts = await youtubeSourceProvider.read(source, broken);

		expect(posts).toHaveLength(1);
		expect(broken.urls.at(-1)).toContain(CHANNEL);
	});

	it('refuses directly rather than fetching a feed url with no id in it', async () => {
		// Unreachable through the orchestrator, which asks `unusable` first — but a provider has to
		// be correct when called directly, and the alternative is requesting `?channel_id=`.
		const context = youtubeContext();

		await expect(
			youtubeSourceProvider.read({ ...source, target: 'nonsense target' }, context)
		).rejects.toBeInstanceOf(SourceFailure);
		expect(context.urls).toStrictEqual([]);
	});
});
