/**
 * Adding numbers across platforms, which is the one thing here that can be silently wrong.
 *
 * A total is a single number somebody might repeat in a sponsorship conversation. Everything in
 * this file is about the ways a plausible-looking one is not a number at all: an all-time count
 * added to a 28-day count, two different period lengths added together, a complete figure averaged
 * with an estimate and presented as fact.
 */

import { describe, expect, it } from 'vitest';
import { METRICS, METRIC_KINDS, consolidate } from './metrics.js';
import type { MetricReading, PlatformMetrics } from './metrics.js';

/** One platform, with the readings given. */
function platform(label: string, readings: readonly MetricReading[]): PlatformMetrics {
	return { platform: label, label, readings, ok: true, reason: null };
}

/** A reading, with the parts most cases do not care about filled in. */
function reading(overrides: Partial<MetricReading> = {}): MetricReading {
	return {
		kind: 'followers',
		window: 'now',
		value: 100,
		origin: 'platform',
		complete: true,
		...overrides
	};
}

describe('every metric is defined', () => {
	it('has a definition for each kind, so a renderer cannot be handed one it cannot label', () => {
		// The map is a total `Record`, so this cannot fail at runtime without failing to compile
		// first — which is the point. It is asserted anyway because the *reverse* is possible: a
		// definition for a kind that is not in the list would sit there unused and unnoticed.
		expect(Object.keys(METRICS).sort()).toStrictEqual([...METRIC_KINDS].sort());
	});
});

describe('adding across platforms', () => {
	it('adds the same metric and window together', () => {
		expect(
			consolidate([
				platform('twitch', [reading({ value: 1200 })]),
				platform('bluesky', [reading({ value: 340 })])
			])
		).toStrictEqual([
			{
				kind: 'followers',
				window: 'now',
				value: 1540,
				platforms: 2,
				complete: true,
				origins: ['platform']
			}
		]);
	});

	it('keeps a different window as its own row rather than adding it', () => {
		// The headline trap. Both of these are "views" and adding them produces a number that is
		// not any quantity at all.
		const totals = consolidate([
			platform('youtube', [reading({ kind: 'views', window: 'all_time', value: 1_000_000 })]),
			platform('tiktok', [reading({ kind: 'views', window: 'period', days: 28, value: 5_000 })])
		]);

		expect(totals).toHaveLength(2);
		expect(totals.map((total) => total.value).sort((left, right) => left - right)).toStrictEqual([
			5_000, 1_000_000
		]);
	});

	it('keeps two different period lengths apart', () => {
		// Both are `window: 'period'`, which is why the period length is part of the grouping key
		// and not merely a label. A seven-day figure plus a twenty-eight-day figure is nothing.
		const totals = consolidate([
			platform('a', [reading({ kind: 'views', window: 'period', days: 7, value: 10 })]),
			platform('b', [reading({ kind: 'views', window: 'period', days: 28, value: 20 })])
		]);

		expect(totals).toHaveLength(2);
		expect(totals.map((total) => total.days)).toStrictEqual([7, 28]);
	});

	it('adds two readings that agree on the period length', () => {
		const totals = consolidate([
			platform('a', [reading({ kind: 'views', window: 'period', days: 28, value: 10 })]),
			platform('b', [reading({ kind: 'views', window: 'period', days: 28, value: 20 })])
		]);

		expect(totals).toStrictEqual([
			{
				kind: 'views',
				window: 'period',
				days: 28,
				value: 30,
				platforms: 2,
				complete: true,
				origins: ['platform']
			}
		]);
	});

	it('counts how many platforms contributed, not how many exist', () => {
		// A platform with nothing to say about this metric is not a contributor. The count is what
		// the page uses to decide whether to warn about double-counting people.
		const totals = consolidate([
			platform('a', [reading({ value: 10 })]),
			platform('b', [reading({ kind: 'views', value: 99 })]),
			platform('c', [reading({ value: 20 })])
		]);

		expect(totals.find((total) => total.kind === 'followers')?.platforms).toBe(2);
	});

	it('is incomplete as soon as one contribution is', () => {
		// No partial credit: a sum containing an unknown is unknown, and a page that rounds that to
		// "complete" is the whole failure this field exists to prevent.
		const totals = consolidate([
			platform('a', [reading({ kind: 'views', value: 10, complete: true })]),
			platform('b', [reading({ kind: 'views', value: 20, complete: false })])
		]);

		expect(totals[0]).toMatchObject({ value: 30, complete: false });
	});

	it('records every origin that went into a total, without repeating one', () => {
		const totals = consolidate([
			platform('a', [reading({ kind: 'views', origin: 'platform' })]),
			platform('b', [reading({ kind: 'views', origin: 'derived' })]),
			platform('c', [reading({ kind: 'views', origin: 'platform' })])
		]);

		expect(totals[0]?.origins).toStrictEqual(['platform', 'derived']);
	});

	it('orders rows by the metric list rather than by which platform answered first', () => {
		// So the page's rows do not move around as platforms come and go, which is what a map's
		// insertion order would do.
		const totals = consolidate([
			platform('a', [
				reading({ kind: 'live_viewers' }),
				reading({ kind: 'views' }),
				reading({ kind: 'followers' })
			])
		]);

		expect(totals.map((total) => total.kind)).toStrictEqual(['followers', 'views', 'live_viewers']);
	});

	it('leaves out a metric that cannot meaningfully be added', () => {
		// None of the current kinds are non-additive, so this is asserted against a definition that
		// says so rather than against a kind that happens to. The first rate or average added to
		// `METRIC_KINDS` would otherwise be summed by code that had no way to know.
		const rate = { ...METRICS.views, additive: false };
		const saved = METRICS.views;

		try {
			Object.assign(METRICS, { views: rate });

			expect(consolidate([platform('a', [reading({ kind: 'views' })])])).toStrictEqual([]);
		} finally {
			Object.assign(METRICS, { views: saved });
		}
	});

	it('has nothing to say about no platforms', () => {
		expect(consolidate([])).toStrictEqual([]);
	});

	it('has nothing to say about platforms with no readings', () => {
		expect(consolidate([platform('a', []), platform('b', [])])).toStrictEqual([]);
	});

	it('does not drop a failed platform’s cached readings', () => {
		// `ok: false` with readings is a real state: the orchestrator keeps the last good numbers
		// when a refresh fails, and a stale follower count is worth more than an empty row.
		expect(
			consolidate([{ platform: 'a', label: 'a', readings: [reading()], ok: false, reason: 'no' }])
		).toHaveLength(1);
	});
});
