/**
 * The four behaviours that are the reason this class exists rather than a Map or a keyv store.
 *
 * These mirror the checks run against the PHP original in production before it was ported, so a
 * regression here is a real behaviour change and not a style disagreement.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cache } from './cache.js';

let directory: string;
let cache: Cache;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'creator-site-cache-test-'));
	cache = new Cache(directory);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('Cache.remember', () => {
	it('fetches on a cold cache and serves without refetching while fresh', async () => {
		let calls = 0;
		const refresh = () => ++calls;

		const cold = await cache.remember('k', 60, refresh);
		const warm = await cache.remember('k', 60, refresh);

		expect(cold).toMatchObject({ data: 1, age: 0, stale: false, error: null });
		expect(warm.data).toBe(1);
		expect(warm.stale).toBe(false);
		expect(calls).toBe(1);
	});

	it('refetches when forced, however fresh the entry is', async () => {
		let calls = 0;
		const refresh = () => ++calls;

		await cache.remember('k', 3600, refresh);
		const forced = await cache.remember('k', 3600, refresh, true);

		expect(forced.data).toBe(2);
		expect(forced.stale).toBe(false);
		expect(calls).toBe(2);
	});

	it('serves the stale value with the reason when a refresh throws', async () => {
		await cache.remember('k', 60, () => 'good');

		const failed = await cache.remember<string>(
			'k',
			60,
			() => {
				throw new Error('upstream said no');
			},
			true
		);

		// The whole point: real data *and* an error, so a page can draw the figures and say why
		// they are old rather than choosing between the two.
		expect(failed.data).toBe('good');
		expect(failed.stale).toBe(true);
		expect(failed.error).toBe('upstream said no');
	});

	it('reports null data when there is nothing cached and the refresh fails', async () => {
		const failed = await cache.remember('cold', 60, () => {
			throw new Error('nope');
		});

		expect(failed.data).toBeNull();
		expect(failed.stale).toBe(true);
		expect(failed.error).toBe('nope');
		// Not MAX_SAFE_INTEGER: pages print this as an age, and "fetched 292 billion years ago" is
		// not an improvement on "now".
		expect(failed.age).toBe(0);
	});

	it('refreshes once when several callers arrive together', async () => {
		let calls = 0;
		const refresh = async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 50));

			return calls;
		};

		const results = await Promise.all([
			cache.remember('k', 60, refresh),
			cache.remember('k', 60, refresh),
			cache.remember('k', 60, refresh)
		]);

		// One fetch; the losers of the lock report themselves as stale rather than stampeding.
		expect(calls).toBe(1);
		expect(results.filter((r) => r.stale)).toHaveLength(2);
	});
});

describe('Cache.get / put / forget', () => {
	it('round-trips a value and reports its age', async () => {
		await cache.put('k', { hello: 'world' });
		const got = await cache.get<{ hello: string }>('k');

		expect(got?.data).toEqual({ hello: 'world' });
		expect(got?.age).toBeGreaterThanOrEqual(0);
	});

	it('returns null for a key that was never written, and after forget', async () => {
		expect(await cache.get('missing')).toBeNull();

		await cache.put('k', 1);
		await cache.forget('k');

		expect(await cache.get('k')).toBeNull();
	});

	it('treats a corrupt entry as a miss rather than throwing', async () => {
		await cache.put('k', 1);
		// Reach in and truncate it the way an interrupted write once did in production.
		const { writeFile } = await import('node:fs/promises');
		const { createHash } = await import('node:crypto');
		const path = join(
			directory,
			`${createHash('sha256').update('k').digest('hex').slice(0, 32)}.json`
		);
		await writeFile(path, '{"at":17913', 'utf8');

		expect(await cache.get('k')).toBeNull();
	});
});
