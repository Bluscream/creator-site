/**
 * Gathering every platform's numbers, including the cases where the honest answer is "not that".
 *
 * Three behaviours carry the weight here, and all three are about not showing a number that looks
 * like something it is not:
 *
 * - a platform with no reader still appears, with a derived figure and the reason it has no better
 *   one, rather than being silently absent;
 * - a reported figure replaces a derived one for the same metric and window, so one row never holds
 *   two different answers to the same question;
 * - a read that fails falls back to the last good numbers and says so, rather than reporting zero.
 *
 * The orchestrator is imported fresh per test, the way `posts.test.ts` does it, because the modules
 * it reads cache at module scope.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cache } from './cache.js';
import type { MetricReading } from '../metrics.js';
import type { ContentPiece } from '../posts.js';
import type { ResolvedSource } from './providers/post.js';

/** The sources the mocked configuration will report. */
let sources: ResolvedSource[] = [];

/** The posts the mocked orchestrator will report, and what it was asked for. */
let content: ContentPiece[] = [];
let askedFor: Record<string, unknown> | null = null;

/** What each kind's metrics provider will do, by kind. Absent means "no reader". */
const behaviour = new Map<string, () => Promise<readonly MetricReading[]>>();

vi.mock('./feed.js', () => ({
	feedConfig: () => ({ enabled: true, limit: 24, refresh: 600, sources: [] }),
	feedSources: () => sources
}));

vi.mock('./posts.js', () => ({
	posts: (options: Record<string, unknown>) => {
		askedFor = options;

		return Promise.resolve({ available: true, posts: content, sources: [], age: 0, stale: false });
	}
}));

vi.mock('./providers/metrics-registry.js', () => ({
	metricsSourceProvider: (kind: string) => ({
		unusable: () =>
			behaviour.has(kind) ? null : `Reading numbers from this platform is not built yet.`,
		read: async () => {
			const act = behaviour.get(kind);

			if (act === undefined) throw new Error('read without a behaviour');

			return act();
		}
	}),
	measuredKinds: () => [...behaviour.keys()],
	plannedMetricKinds: () => []
}));

vi.mock('./log.js', () => ({
	log: () => ({
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined
	})
}));

let directory: string;
let cache: Cache;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'creator-site-metrics-'));
	cache = new Cache(join(directory, 'cache'));
	sources = [];
	content = [];
	askedFor = null;
	behaviour.clear();
	vi.stubEnv('DATA_DIR', directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

/**
 * Makes every cached entry look `seconds` old.
 *
 * Copied in spirit from `posts.test.ts`: the cache stores its own `at` in each file rather than
 * relying on mtime, so this rewrites that. Every file rather than one by name, because the key is
 * hashed and reconstructing the hash would be testing the cache's private business.
 */
function backdate(seconds: number): void {
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

/** The module under test, imported fresh. */
async function freshMetrics() {
	vi.resetModules();

	return import('./metrics.js');
}

/** A configured source. */
function source(id: string, kind: string): ResolvedSource {
	return {
		id,
		kind: kind as ResolvedSource['kind'],
		target: 'someone',
		label: id,
		platform: kind
	};
}

/** A post from a source, with a view count or without one. */
function piece(from: string, id: string, views: number | null): ContentPiece {
	return {
		id: `${from}:${id}`,
		source: from,
		platform: from,
		kind: 'video',
		title: id,
		url: `https://example.com/${id}`,
		body: '',
		at: '2026-10-01T00:00:00.000Z',
		author: null,
		media: [],
		duration: null,
		views,
		live: false,
		visibility: 'public'
	};
}

describe('with nothing configured', () => {
	it('reports itself unavailable rather than failing', async () => {
		const { metrics } = await freshMetrics();

		await expect(metrics({ cache })).resolves.toStrictEqual({
			available: false,
			overall: [],
			platforms: []
		});
	});
});

describe('a platform whose numbers nobody can read yet', () => {
	beforeEach(() => {
		sources = [source('youtube', 'youtube')];
	});

	it('still appears, with the reason it has nothing of its own', async () => {
		// The alternative — leaving it out — looks exactly like a platform with nothing to report,
		// and this is the state every platform but Bluesky is in today.
		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		// Asserted field by field rather than with `expect.stringContaining`, which is typed `any` and
		// would make the whole matcher object unchecked — including the two fields that are the point.
		expect(result.platforms[0]?.label).toBe('youtube');
		expect(result.platforms[0]?.ok).toBe(false);
		expect(result.platforms[0]?.reason).toMatch(/not built yet/);
	});

	it('derives what it can from the posts this install already has', async () => {
		content = [piece('youtube', '1', 100), piece('youtube', '2', 250)];

		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		expect(result.platforms[0]?.readings).toStrictEqual([
			{ kind: 'posts', window: 'now', value: 2, origin: 'derived', complete: false },
			{ kind: 'views', window: 'now', value: 350, origin: 'derived', complete: false }
		]);
	});

	it('marks a derived figure incomplete, because it covers only what was fetched', async () => {
		// The claim that matters. Presenting "the views on the posts we happened to read" as the
		// channel's view count would be wrong by a margin nobody can state.
		content = [piece('youtube', '1', 100)];

		const { metrics } = await freshMetrics();

		for (const reading of (await metrics({ cache })).platforms[0]?.readings ?? []) {
			expect(reading.complete).toBe(false);
			expect(reading.origin).toBe('derived');
		}
	});

	it('derives no view count when the platform publishes none', async () => {
		// Not zero. "Nobody watched" and "nobody says" are different facts, and only one is bad news.
		content = [piece('youtube', '1', null), piece('youtube', '2', null)];

		const { metrics } = await freshMetrics();

		expect((await metrics({ cache })).platforms[0]?.readings.map((r) => r.kind)).toStrictEqual([
			'posts'
		]);
	});

	it('counts only the posts from that source', async () => {
		sources = [source('youtube', 'youtube'), source('twitch', 'twitch')];
		content = [piece('youtube', '1', null), piece('twitch', '1', null), piece('twitch', '2', null)];

		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		expect(result.platforms.map((platform) => platform.readings[0]?.value)).toStrictEqual([1, 2]);
	});

	it('derives nothing for a source that contributed no posts', async () => {
		const { metrics } = await freshMetrics();

		expect((await metrics({ cache })).platforms[0]?.readings).toStrictEqual([]);
	});
});

describe('a platform that reports its own numbers', () => {
	beforeEach(() => {
		sources = [source('bluesky', 'bluesky')];
	});

	it('uses them, and says they came from the platform', async () => {
		behaviour.set('bluesky', () =>
			Promise.resolve([
				{
					kind: 'followers' as const,
					window: 'now' as const,
					value: 4200,
					origin: 'platform' as const,
					complete: true
				}
			])
		);

		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		expect(result.platforms[0]).toMatchObject({ ok: true, reason: null });
		expect(result.platforms[0]?.readings[0]).toMatchObject({ value: 4200, origin: 'platform' });
	});

	it('replaces a derived figure with the reported one for the same metric and window', async () => {
		// Two numbers for one metric and window would put two rows on one line and double the
		// total. The reported one wins because it is the platform's answer to the question the
		// derived one is estimating.
		content = [piece('bluesky', '1', null), piece('bluesky', '2', null)];
		behaviour.set('bluesky', () =>
			Promise.resolve([
				{
					kind: 'posts' as const,
					window: 'now' as const,
					value: 866,
					origin: 'platform' as const,
					complete: true
				}
			])
		);

		const { metrics } = await freshMetrics();
		const readings = (await metrics({ cache })).platforms[0]?.readings ?? [];

		expect(readings).toHaveLength(1);
		expect(readings[0]).toMatchObject({ value: 866, origin: 'platform' });
	});

	it('keeps a derived figure whose window the platform did not report', async () => {
		// `posts` all-time and `posts` now are different quantities, so the reported one does not
		// displace the derived one — which is the same rule the overall view groups by.
		content = [piece('bluesky', '1', null)];
		behaviour.set('bluesky', () =>
			Promise.resolve([
				{
					kind: 'posts' as const,
					window: 'all_time' as const,
					value: 866,
					origin: 'platform' as const,
					complete: true
				}
			])
		);

		const { metrics } = await freshMetrics();
		const readings = (await metrics({ cache })).platforms[0]?.readings ?? [];

		expect(readings.map((reading) => reading.window)).toStrictEqual(['all_time', 'now']);
	});
});

describe('when reading a platform fails', () => {
	beforeEach(() => {
		sources = [source('bluesky', 'bluesky')];
	});

	it('keeps the numbers it last managed to read, and says what went wrong', async () => {
		// A stale follower count is worth more than an empty row, which is the same decision the
		// posts orchestrator makes about a failed refresh.
		behaviour.set('bluesky', () =>
			Promise.resolve([
				{
					kind: 'followers' as const,
					window: 'now' as const,
					value: 4200,
					origin: 'platform' as const,
					complete: true
				}
			])
		);

		const first = await freshMetrics();

		await first.metrics({ cache });

		// Aged past the refresh interval, or the second call serves the cache and never reads — which
		// is correct behaviour and not the path under test. The first version of this test missed
		// that and asserted a failure that never happened.
		backdate(3600);

		const again = await freshMetrics();

		// Imported *after* the reset, and that ordering is the whole subtlety. `freshMetrics` calls
		// `vi.resetModules()`, so the `metrics.js` it returns holds a freshly-imported
		// `posts-source.js` — and a `SourceFailure` taken from before the reset is a different class
		// object, so `instanceof` is false and the orchestrator correctly treats it as an unknown
		// error. The test then "failed" by reporting the generic message, which is the right
		// behaviour for a value that genuinely is not a `SourceFailure`.
		const { SourceFailure } = await import('./providers/posts-source.js');

		behaviour.set('bluesky', () => Promise.reject(new SourceFailure('Bluesky answered 503.')));

		const result = await again.metrics({ cache });

		expect(result.platforms[0]).toMatchObject({ ok: false, reason: 'Bluesky answered 503.' });
		expect(result.platforms[0]?.readings[0]).toMatchObject({ value: 4200 });
	});

	it('does not pass through the message of something that is not a SourceFailure', async () => {
		// A transport error's own message can carry a url with a token in its query string, and this
		// is rendered in the admin. The generic sentence is deliberate.
		behaviour.set('bluesky', () =>
			Promise.reject(new Error('fetch failed: https://api.example.com/?access_token=hunter2'))
		);

		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		expect(result.platforms[0]?.reason).toBe('Reading numbers from bluesky did not work.');
		expect(JSON.stringify(result)).not.toContain('hunter2');
	});
});

describe('the overall view', () => {
	it('adds the platforms together', async () => {
		sources = [source('a', 'bluesky'), source('b', 'bluesky')];
		behaviour.set('bluesky', () =>
			Promise.resolve([
				{
					kind: 'followers' as const,
					window: 'now' as const,
					value: 50,
					origin: 'platform' as const,
					complete: true
				}
			])
		);

		const { metrics } = await freshMetrics();
		const result = await metrics({ cache });

		expect(result.overall).toStrictEqual([
			{
				kind: 'followers',
				window: 'now',
				value: 100,
				platforms: 2,
				complete: true,
				origins: ['platform']
			}
		]);
	});

	it('is unavailable when no platform contributed a single number', async () => {
		sources = [source('youtube', 'youtube')];

		const { metrics } = await freshMetrics();

		// A page saying "nothing yet" is a better answer than a page of empty rows.
		expect((await metrics({ cache })).available).toBe(false);
	});
});

describe('what it asks the posts orchestrator for', () => {
	it('asks for everything, by name, because this is the admin’s own view', async () => {
		// The default is public-only, which is right for a public page and wrong here: an admin
		// looking at their own numbers should be counting their unlisted posts too.
		sources = [source('youtube', 'youtube')];

		const { metrics } = await freshMetrics();

		await metrics({ cache });

		expect(askedFor?.audience).toBe('everything');
		expect(askedFor?.limit).toBe(0);
	});
});
