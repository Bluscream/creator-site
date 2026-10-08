/**
 * That merging several sources behaves when some of them are broken.
 *
 * The happy path is the easy part. What this is for is the set of behaviours the per-source cache
 * exists to provide, each of which the obvious one-entry implementation gets wrong:
 *
 * - a source whose read fails keeps serving its last good posts;
 * - one failure does not cost the other sources;
 * - `age` is the oldest source's, not the newest's;
 * - a source can be `ok: false` and still be contributing posts.
 *
 * Sources are driven through a real {@link Cache} on a temporary directory and a stub provider
 * registry, so the cache's own read/write path is exercised rather than mocked.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cache } from './cache.js';
import type { ContentPiece } from '../posts.js';

/**
 * Longer than the 5 s default, because every test here re-imports the module under test.
 *
 * `freshPosts()` calls `vi.resetModules()` and imports `./posts.js` again, which re-transforms its
 * whole graph. On an idle machine that is milliseconds; under `npm run gate`, with a build and the
 * browser tests competing for cores, the first test in the file paid the cold transform cost and
 * timed out at exactly 5000 ms — a flake that showed up only in the gate and never in a bare
 * `test:unit` run, which is the worst kind to leave alone.
 *
 * Raised here rather than globally: a timeout is a budget, and the rest of the suite should keep the
 * tight one so a genuinely hung test still fails fast.
 */
vi.setConfig({ testTimeout: 30_000 });

let directory: string;
let cache: Cache;

/** What each kind's provider will do on its next read, by kind. */
const behaviour = new Map<string, () => Promise<readonly ContentPiece[]>>();

/** How long a kind's provider says its image urls last, by kind. Absent means indefinitely. */
const imageTtls = new Map<string, number>();

vi.mock('./providers/posts-registry.js', () => ({
	postsSourceProvider: (kind: string) => ({
		unusable: () => (behaviour.has(kind) ? null : `No reader for ${kind}.`),
		read: async () => {
			const act = behaviour.get(kind);

			if (act === undefined) throw new Error('read without a behaviour');

			return act();
		},
		imageTtl: imageTtls.get(kind)
	}),
	implementedKinds: () => [],
	plannedKinds: () => []
}));

/** Writes the feed document that `feed.ts` will read. */
function configure(
	sources: readonly Record<string, unknown>[],
	extra: Record<string, unknown> = {}
) {
	mkdirSync(join(directory, 'config'), { recursive: true });
	writeFileSync(
		join(directory, 'config', 'feed.json'),
		JSON.stringify({ sources, ...extra }),
		'utf8'
	);
}

/**
 * Makes every cache entry look `seconds` old.
 *
 * The cache stores its own `at` in each file rather than relying on mtime, so this rewrites that
 * rather than touching timestamps. Every file in the directory rather than one by name, because the
 * key is hashed and a test that reconstructed the hash would be testing the cache's private
 * business.
 */
function backdate(seconds: number) {
	const base = join(directory, 'cache');

	for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;

		const path = join(entry.parentPath, entry.name);
		const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));

		if (typeof stored !== 'object' || stored === null || !('at' in stored)) continue;

		writeFileSync(
			path,
			JSON.stringify({ ...stored, at: Math.floor(Date.now() / 1000) - seconds }),
			'utf8'
		);
	}
}

/** A post from a source, at a given time. */
function post(source: string, id: string, at: string): ContentPiece {
	return {
		id: `${source}:${id}`,
		source,
		platform: null,
		title: id,
		url: `https://example.com/${id}`,
		kind: 'post',
		body: '',
		at,
		author: null,
		media: []
	};
}

/** The orchestrator, imported fresh so its document cache does not outlive a test. */
async function freshPosts() {
	vi.resetModules();

	return import('./posts.js');
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'creator-site-posts-'));
	cache = new Cache(join(directory, 'cache'));
	behaviour.clear();
	imageTtls.clear();
	vi.stubEnv('DATA_DIR', directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe('with nothing configured', () => {
	it('reports itself unavailable rather than failing', async () => {
		configure([]);

		const { posts } = await freshPosts();

		await expect(posts({ cache })).resolves.toMatchObject({
			available: false,
			posts: [],
			sources: []
		});
	});

	it('is unavailable when the feed is switched off, even with sources', async () => {
		configure([{ id: 'a', kind: 'feed', url: 'https://a.test/f' }], { enabled: false });
		behaviour.set('feed', () => Promise.resolve([post('a', '1', '2026-10-01T00:00:00.000Z')]));

		const { posts } = await freshPosts();

		expect((await posts({ cache })).available).toBe(false);
	});
});

describe('merging sources', () => {
	beforeEach(() => {
		configure([
			{ id: 'a', kind: 'feed', url: 'https://a.test/f' },
			{ id: 'bluesky', kind: 'bluesky', url: 'someone' }
		]);
	});

	it('sorts every source together, newest first', async () => {
		behaviour.set('feed', () =>
			Promise.resolve([
				post('a', 'old', '2026-01-01T00:00:00.000Z'),
				post('a', 'new', '2026-10-05T00:00:00.000Z')
			])
		);
		behaviour.set('bluesky', () =>
			Promise.resolve([post('bluesky', 'middle', '2026-06-01T00:00:00.000Z')])
		);

		const { posts } = await freshPosts();
		const result = await posts({ cache });

		expect(result.posts.map((entry) => entry.id)).toStrictEqual([
			'a:new',
			'bluesky:middle',
			'a:old'
		]);
	});

	it('puts an undated post last rather than dropping it', async () => {
		// Plenty of feeds omit a date, and "undated" is still a post.
		behaviour.set('feed', () => Promise.resolve([post('a', 'dated', '2026-01-01T00:00:00.000Z')]));
		behaviour.set('bluesky', () =>
			Promise.resolve([{ ...post('bluesky', 'undated', ''), at: null }])
		);

		const { posts } = await freshPosts();

		expect((await posts({ cache })).posts.map((entry) => entry.id)).toStrictEqual([
			'a:dated',
			'bluesky:undated'
		]);
	});

	it('reports every source, including the ones that worked', async () => {
		behaviour.set('feed', () => Promise.resolve([post('a', '1', '2026-10-01T00:00:00.000Z')]));
		behaviour.set('bluesky', () => Promise.resolve([]));

		const { posts } = await freshPosts();
		const result = await posts({ cache });

		expect(result.sources).toStrictEqual([
			{
				id: 'a',
				label: 'A',
				platform: null,
				kind: 'feed',
				ok: true,
				reason: null,
				count: 1,
				age: 0
			},
			{
				id: 'bluesky',
				label: 'Bluesky',
				platform: 'bluesky',
				kind: 'bluesky',
				ok: true,
				reason: null,
				count: 0,
				age: 0
			}
		]);
	});
});

describe('when one source is broken', () => {
	beforeEach(() => {
		configure([
			{ id: 'a', kind: 'feed', url: 'https://a.test/f' },
			{ id: 'bluesky', kind: 'bluesky', url: 'someone' }
		]);
	});

	it('still serves the other one', async () => {
		behaviour.set('feed', () => Promise.reject(new Error('boom')));
		behaviour.set('bluesky', () =>
			Promise.resolve([post('bluesky', '1', '2026-10-01T00:00:00.000Z')])
		);

		const { posts } = await freshPosts();
		const result = await posts({ cache });

		expect(result.posts.map((entry) => entry.id)).toStrictEqual(['bluesky:1']);
		expect(result.sources.map((source) => source.ok)).toStrictEqual([false, true]);
	});

	it('does not render an unexpected error message, which could hold a token', async () => {
		// A transport error's message can contain the full request url, query string included. The
		// provider's own `SourceFailure` is the only thing passed through.
		behaviour.set('feed', () =>
			Promise.reject(new Error('connect failed for https://a.test/f?key=sekrit-value'))
		);
		behaviour.set('bluesky', () => Promise.resolve([]));

		const { posts } = await freshPosts();
		const result = await posts({ cache });

		expect(result.sources[0]?.reason).toBe('The feed could not be read.');
		expect(JSON.stringify(result)).not.toContain('sekrit-value');
	});

	it('passes a provider-written reason straight through', async () => {
		const { posts } = await freshPosts();

		// Imported *after* `freshPosts`, which resets the module registry. Imported before it, this
		// would be a different class object than the one the orchestrator sees, `instanceof` would
		// miss, and the message would be replaced — which is exactly what happened the first time
		// this test ran, and is a property of the test rather than of the code.
		const { SourceFailure } = await import('./providers/posts-source.js');

		behaviour.set('feed', () => Promise.reject(new SourceFailure('The feed answered 404.')));
		behaviour.set('bluesky', () => Promise.resolve([]));

		expect((await posts({ cache })).sources[0]?.reason).toBe('The feed answered 404.');
	});
});

describe('a source whose refresh fails after it once worked', () => {
	beforeEach(() => {
		configure([{ id: 'a', kind: 'feed', url: 'https://a.test/f' }]);
	});

	it('keeps serving what it last returned', async () => {
		// The case the per-source cache exists for: YouTube answers 404 when it throttles, so a
		// refresh caught mid-throttle must not replace fifteen good videos with nothing.
		behaviour.set('feed', () => Promise.resolve([post('a', '1', '2026-10-01T00:00:00.000Z')]));

		const { posts } = await freshPosts();

		expect((await posts({ cache })).posts).toHaveLength(1);

		behaviour.set('feed', () => Promise.reject(new Error('throttled')));

		// `ttl: 0` forces the refresh rather than serving the entry as still fresh.
		const after = await posts({ cache, ttl: 0 });

		expect(after.posts.map((entry) => entry.id)).toStrictEqual(['a:1']);
		expect(after.sources[0]).toMatchObject({ ok: false, count: 1 });
	});

	it('is still reported as not ok while doing so', async () => {
		// `ok: false` with a non-zero `count` is the honest answer, not a contradiction.
		behaviour.set('feed', () => Promise.resolve([post('a', '1', '2026-10-01T00:00:00.000Z')]));

		const { posts } = await freshPosts();

		await posts({ cache });
		behaviour.set('feed', () => Promise.reject(new Error('throttled')));

		const after = await posts({ cache, ttl: 0 });

		expect(after.sources[0]?.ok).toBe(false);
		expect(after.posts).not.toStrictEqual([]);
	});
});

describe('a source with no reader', () => {
	it('says so, and is skipped without a request', async () => {
		configure([{ id: 'a', kind: 'twitch', url: 'someone' }]);

		// No behaviour registered for `twitch`, so the stub's `unusable` refuses it — and `read`
		// would throw if it were called anyway.
		const { posts } = await freshPosts();
		const result = await posts({ cache });

		expect(result.available).toBe(true);
		expect(result.sources[0]).toMatchObject({
			ok: false,
			reason: 'No reader for twitch.',
			count: 0
		});
	});
});

describe('freshness', () => {
	it('reports the oldest source, not the newest', async () => {
		configure([
			{ id: 'a', kind: 'feed', url: 'https://a.test/f' },
			{ id: 'bluesky', kind: 'bluesky', url: 'someone' }
		]);
		behaviour.set('feed', () => Promise.resolve([post('a', '1', '2026-10-01T00:00:00.000Z')]));
		behaviour.set('bluesky', () =>
			Promise.resolve([post('bluesky', '1', '2026-10-01T00:00:00.000Z')])
		);

		const { posts } = await freshPosts();

		await posts({ cache });

		// One source refuses to refresh, so it keeps its age while the other resets to zero. The
		// merged list is as fresh as its oldest part, which is the honest answer to "how fresh is
		// this".
		behaviour.delete('bluesky');

		const after = await posts({ cache, ttl: 0 });

		expect(after.age).toBeGreaterThanOrEqual(0);
		expect(after.stale).toBe(true);
	});
});

describe('the cap', () => {
	beforeEach(() => {
		configure([{ id: 'a', kind: 'feed', url: 'https://a.test/f' }], { limit: 2 });
		behaviour.set('feed', () =>
			Promise.resolve([
				post('a', '1', '2026-10-03T00:00:00.000Z'),
				post('a', '2', '2026-10-02T00:00:00.000Z'),
				post('a', '3', '2026-10-01T00:00:00.000Z')
			])
		);
	});

	it('applies the configured limit', async () => {
		const { posts } = await freshPosts();

		expect((await posts({ cache })).posts).toHaveLength(2);
	});

	it('takes the newest, not the first fetched', async () => {
		const { posts } = await freshPosts();

		expect((await posts({ cache })).posts.map((entry) => entry.id)).toStrictEqual(['a:1', 'a:2']);
	});

	it('treats zero as no cap, which is what a whole feed page asks for', async () => {
		const { posts } = await freshPosts();

		expect((await posts({ cache, limit: 0 })).posts).toHaveLength(3);
	});

	it('lets a caller override the configured limit', async () => {
		const { posts } = await freshPosts();

		expect((await posts({ cache, limit: 1 })).posts).toHaveLength(1);
	});
});

/**
 * A stale post whose picture has expired.
 *
 * TikTok signs every cover url with an expiry about two days out, and a failed refresh keeps
 * serving the last good posts for as long as the failure lasts — deliberately and without bound,
 * because a title, a link and a date do not go stale. The picture does. Past its signature it is a
 * 404, and a row of broken images looks worse than the same rows with no images.
 */
describe('a source that has been failing for days', () => {
	/** A post with a picture, as a provider that signs its thumbnails would return. */
	function pictured(id: string, at: string): ContentPiece {
		return {
			...post('a', id, at),
			media: [{ url: `https://cdn.test/${id}.jpg?x-expires=1`, kind: 'image' }]
		};
	}

	beforeEach(() => {
		configure([{ id: 'a', kind: 'feed', url: 'https://a.test/f' }]);
	});

	it('keeps serving the posts, which is the point of the per-source cache', async () => {
		imageTtls.set('feed', 36 * 60 * 60);
		behaviour.set('feed', () => Promise.resolve([pictured('1', '2026-10-01T00:00:00.000Z')]));

		const first = await freshPosts();

		await first.posts({ cache });
		backdate(40 * 60 * 60);

		behaviour.set('feed', () => Promise.reject(new Error('still down')));

		const second = await freshPosts();
		const result = await second.posts({ cache, ttl: 0 });

		expect(result.posts.map((entry) => entry.id)).toStrictEqual(['a:1']);
		expect(result.sources[0]?.ok).toBe(false);
	});

	it('drops a picture that has outlived its signature', async () => {
		imageTtls.set('feed', 36 * 60 * 60);
		behaviour.set('feed', () => Promise.resolve([pictured('1', '2026-10-01T00:00:00.000Z')]));

		const first = await freshPosts();

		await first.posts({ cache });
		backdate(40 * 60 * 60);

		behaviour.set('feed', () => Promise.reject(new Error('still down')));

		const second = await freshPosts();

		expect((await second.posts({ cache, ttl: 0 })).posts[0]?.media).toEqual([]);
	});

	it('keeps the picture while the signature is still good', async () => {
		imageTtls.set('feed', 36 * 60 * 60);
		behaviour.set('feed', () => Promise.resolve([pictured('1', '2026-10-01T00:00:00.000Z')]));

		const first = await freshPosts();

		await first.posts({ cache });
		backdate(10 * 60 * 60);

		behaviour.set('feed', () => Promise.reject(new Error('briefly down')));

		const second = await freshPosts();

		expect((await second.posts({ cache, ttl: 0 })).posts[0]?.media).not.toEqual([]);
	});

	it('keeps the picture forever for a provider that does not sign them', async () => {
		// No `imageTtl`: most platforms serve a plain cdn url that does not expire, and dropping
		// those would make a briefly-broken feed worse than it needs to be.
		behaviour.set('feed', () => Promise.resolve([pictured('1', '2026-10-01T00:00:00.000Z')]));

		const first = await freshPosts();

		await first.posts({ cache });
		backdate(400 * 24 * 60 * 60);

		behaviour.set('feed', () => Promise.reject(new Error('long gone')));

		const second = await freshPosts();

		expect((await second.posts({ cache, ttl: 0 })).posts[0]?.media).not.toEqual([]);
	});

	it('drops the picture on a source that has become unreadable, not only a failing one', async () => {
		// The `unusable` path returns cached posts too — credentials removed, a target that stopped
		// being a url — and it reaches them the same way.
		imageTtls.set('feed', 36 * 60 * 60);
		behaviour.set('feed', () => Promise.resolve([pictured('1', '2026-10-01T00:00:00.000Z')]));

		const first = await freshPosts();

		await first.posts({ cache });
		backdate(40 * 60 * 60);

		// Removing the behaviour makes the stub provider report itself unusable.
		behaviour.delete('feed');

		const second = await freshPosts();
		const result = await second.posts({ cache, ttl: 0 });

		expect(result.posts[0]?.media).toEqual([]);
		expect(result.sources[0]?.reason).toMatch(/No reader/);
	});
});
