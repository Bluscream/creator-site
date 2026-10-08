/**
 * Bluesky's follower and post counts.
 *
 * Mostly about what it does with an incomplete answer, because that is where a metrics reader goes
 * wrong in a way nobody notices: a missing count turned into a zero is a number that will be read,
 * believed and possibly quoted, and "nobody follows this account" is a very different statement
 * from "the AppView did not say".
 *
 * One live case at the end, behind `RUN_LIVE=1`, because the whole premise of this provider is that
 * a real endpoint answers a real request with no credential. Nothing offline can check that.
 */

import { describe, expect, it, vi } from 'vitest';
import { blueskyMetricsProvider } from './bluesky-metrics.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

const SOURCE: ResolvedSource = {
	id: 'bluesky',
	kind: 'bluesky',
	target: 'someone.bsky.social',
	label: 'Bluesky',
	platform: 'bluesky'
};

/** A context whose fetch answers with the given status and body. */
function answering(status: number, body: unknown): SourceContext {
	return {
		fetch: () =>
			Promise.resolve(
				new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				})
			),
		store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
	};
}

describe('deciding whether it can read a source at all', () => {
	it.each([
		['a bare handle', 'someone.bsky.social'],
		['a handle with an at sign', '@someone.bsky.social'],
		['a profile url', 'https://bsky.app/profile/someone.bsky.social']
	])('accepts %s', (_what, target) => {
		expect(blueskyMetricsProvider.unusable({ ...SOURCE, target })).toBeNull();
	});

	it('refuses something that is not a handle, with advice rather than a complaint', () => {
		expect(blueskyMetricsProvider.unusable({ ...SOURCE, target: 'not a handle' })).toMatch(
			/Bluesky handle/
		);
	});
});

describe('reading the counts', () => {
	it('reports followers as a snapshot and posts as an all-time total', async () => {
		const readings = await blueskyMetricsProvider.read(
			SOURCE,
			answering(200, { followersCount: 35_192_347, postsCount: 866, followsCount: 15 })
		);

		expect(readings).toStrictEqual([
			{
				kind: 'followers',
				window: 'now',
				value: 35_192_347,
				origin: 'platform',
				complete: true
			},
			{ kind: 'posts', window: 'all_time', value: 866, origin: 'platform', complete: true }
		]);
	});

	it('leaves out a count the AppView did not send, rather than calling it zero', async () => {
		// The case worth the test. A zero here is a number somebody would read and believe.
		const readings = await blueskyMetricsProvider.read(SOURCE, answering(200, { postsCount: 12 }));

		expect(readings.map((reading) => reading.kind)).toStrictEqual(['posts']);
	});

	it('reports a genuine zero, which is not the same as an absent count', async () => {
		const readings = await blueskyMetricsProvider.read(
			SOURCE,
			answering(200, { followersCount: 0, postsCount: 0 })
		);

		expect(readings.map((reading) => reading.value)).toStrictEqual([0, 0]);
	});

	it('does not report how many accounts the creator follows', async () => {
		// In the same response and not a performance metric: a fact about them, not about how the
		// channel is doing. A metrics page that shows it is padding.
		const readings = await blueskyMetricsProvider.read(
			SOURCE,
			answering(200, { followersCount: 1, followsCount: 9_999 })
		);

		expect(readings.map((reading) => reading.value)).toStrictEqual([1]);
	});

	it('returns nothing at all for a profile with no counts', async () => {
		await expect(blueskyMetricsProvider.read(SOURCE, answering(200, {}))).resolves.toStrictEqual(
			[]
		);
	});

	it('names a handle nobody holds, which is the one failure an admin can fix', async () => {
		await expect(
			blueskyMetricsProvider.read(SOURCE, answering(400, { error: 'InvalidRequest' }))
		).rejects.toThrow(/no account called someone.bsky.social/);
	});

	it('reports any other status as the platform answering badly', async () => {
		await expect(blueskyMetricsProvider.read(SOURCE, answering(503, {}))).rejects.toThrow(
			/answered 503/
		);
	});

	it('refuses a body that is not the shape it expects', async () => {
		await expect(
			blueskyMetricsProvider.read(SOURCE, answering(200, { followersCount: 'lots' }))
		).rejects.toThrow(/something unexpected/);
	});

	it('asks for the handle it was given, on the public AppView', async () => {
		// The url matters: `public.api.bsky.app` is the unauthenticated host, and reaching for the
		// authenticated one would make this provider useless on a fan's install.
		// Typed through `SourceContext['fetch']` rather than left to inference: a bare `vi.fn(() => …)`
		// infers a zero-argument signature, so `mock.calls[0][0]` is an index into an empty tuple and
		// the url — the thing under test — cannot be read at all.
		const fetched: SourceContext['fetch'] = vi.fn(() =>
			Promise.resolve(new Response(JSON.stringify({ postsCount: 1 }), { status: 200 }))
		);

		await blueskyMetricsProvider.read(
			{ ...SOURCE, target: '@someone.bsky.social' },
			{
				fetch: fetched,
				store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
			}
		);

		expect(vi.mocked(fetched).mock.calls[0]?.[0]).toBe(
			'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=someone.bsky.social'
		);
	});
});

const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

live('against the real AppView', () => {
	it('reads counts for a long-standing account with no credential', async () => {
		// The premise of this whole provider, which nothing offline can check: that the endpoint
		// answers an anonymous request with numbers. `bsky.app` is Bluesky's own account — it is not
		// going to be deleted, and its counts are large enough that a zero would be a real failure.
		const readings = await blueskyMetricsProvider.read(
			{ ...SOURCE, target: 'bsky.app' },
			{
				fetch: (url) => fetch(url),
				store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
			}
		);

		const followers = readings.find((reading) => reading.kind === 'followers');

		expect(followers?.value).toBeGreaterThan(1000);
		expect(followers?.origin).toBe('platform');
		expect(readings.find((reading) => reading.kind === 'posts')?.value).toBeGreaterThan(0);
	}, 60_000);
});
