/**
 * Every platform's numbers, gathered, with the overall view worked out.
 *
 * The counterpart to `./posts.ts`, over the same configured sources: a creator who has said "this
 * is my Bluesky account" for the feed does not say it again here. Each source is asked twice — once
 * of its metrics provider, and once of the content this install has already read — and the two
 * answers are kept apart rather than blended.
 *
 * ### Reported and derived are different claims
 *
 * A **reported** reading is the platform's own figure: "this account has 35,192,347 followers".
 * A **derived** reading is worked out here from posts that were fetched for the feed: "the posts
 * this install has read have 4,812 views between them". The second is useful and is *not* the
 * channel's view count — it covers whatever happened to be on the page that was fetched, which is
 * a window nobody chose and nobody can state.
 *
 * So a derived reading carries `complete: false` and `origin: 'derived'`, and the page says so. The
 * alternative was to leave them out, and that is worse: for most platforms here they are the only
 * numbers that exist today, and a page with nothing on it teaches nobody anything.
 *
 * Where both exist for the same metric and window, the **reported** one wins and the derived one is
 * dropped — see {@link preferReported}. Keeping both would put two different "posts" numbers on one
 * row and make the total nonsense.
 *
 * ### Admin only
 *
 * Nothing here is public, and that is not about the credentials. The aggregate is a picture the
 * creator did not publish even when every number in it was already public somewhere, so the route
 * that calls this is behind the admin guard and there is no API surface for it.
 */

import { z } from 'zod';
import {
	METRIC_KINDS,
	METRIC_ORIGINS,
	METRIC_WINDOWS,
	NO_METRICS,
	consolidate
} from '../metrics.js';
import type {
	MetricKind,
	MetricReading,
	MetricWindow,
	MetricsResult,
	PlatformMetrics
} from '../metrics.js';
import { Cache } from './cache.js';
import type { Parse } from './cache.js';
import { feedConfig, feedSources } from './feed.js';
import { log } from './log.js';
import { posts } from './posts.js';
import { metricsSourceProvider } from './providers/metrics-registry.js';
import { SourceFailure } from './providers/posts-source.js';
import type { ResolvedSource } from './providers/post.js';
import type { ContentPiece } from '../posts.js';

/** How long a gathered set of numbers is reused before being read again, in seconds. */
const REFRESH = 900;

/**
 * What a provider is given.
 *
 * The same shape `posts.ts` builds, and for the same reason: the deadline, the headers and the
 * redirect policy are decided once rather than by each provider. Duplicated deliberately rather
 * than exported from there — `posts.ts` owns its own cache keys and its own store namespace, and a
 * shared helper would have to take both as arguments to avoid the two colliding, which is more
 * coupling than two short functions are worth.
 */
function context(cache: Cache): Parameters<ReturnType<typeof metricsSourceProvider>['read']>[1] {
	return {
		async fetch(url, init) {
			return fetch(url, {
				signal: AbortSignal.timeout(10_000),
				redirect: 'follow',
				...(init?.method === undefined ? {} : { method: init.method }),
				...(init?.body === undefined ? {} : { body: init.body }),
				headers: {
					'user-agent': 'creator-site metrics',
					...init?.headers
				}
			});
		},

		store: {
			async get(key) {
				// Parsed rather than trusted: a cache file is on disk and this is the one place a
				// provider's resolved identifier comes back into the process. The store is text only,
				// so anything that is not a string is treated as absent.
				const found = await cache.get(`metrics-store-${key}`);

				return typeof found?.data === 'string' ? { value: found.data, age: found.age } : null;
			},

			async put(key, value) {
				await cache.put(`metrics-store-${key}`, value);
			}
		}
	};
}

/**
 * The numbers this install can work out for one platform from content it already has.
 *
 * Two of them, and the limits are stated on each because they are the whole reason these are
 * labelled derived:
 *
 * - `posts` — how many pieces were read. Not how many the account has ever made.
 * - `views` — the sum over those pieces, for platforms that publish a per-item count. A platform
 *   that publishes none contributes no reading at all rather than a zero, because "nobody watched"
 *   and "nobody says" are different facts and only one of them is bad news.
 *
 * `window: 'period'` with no `days` would be a lie about a window nobody chose, and `all_time` is
 * flatly false. So both are `now`: a true statement about what this install is holding at this
 * moment, which is what they are.
 */
function derive(pieces: readonly ContentPiece[]): readonly MetricReading[] {
	if (pieces.length === 0) return [];

	const readings: MetricReading[] = [
		{ kind: 'posts', window: 'now', value: pieces.length, origin: 'derived', complete: false }
	];

	const counted = pieces.filter((piece) => piece.views !== null);

	if (counted.length > 0) {
		readings.push({
			kind: 'views',
			window: 'now',
			value: counted.reduce((total, piece) => total + (piece.views ?? 0), 0),
			origin: 'derived',
			complete: false
		});
	}

	return readings;
}

/** The metric-and-window a reading belongs to, for deciding which of two to keep. */
function slot(reading: MetricReading): string {
	return `${reading.kind}|${reading.window}|${String(reading.days ?? '')}`;
}

/**
 * Reported readings, plus the derived ones that do not duplicate them.
 *
 * Two numbers for one metric and window would put two rows on one line and double the total. The
 * reported one wins because it is the platform's own answer to the question the derived one is
 * estimating.
 */
function preferReported(
	reported: readonly MetricReading[],
	derived: readonly MetricReading[]
): readonly MetricReading[] {
	const taken = new Set(reported.map(slot));

	return [...reported, ...derived.filter((reading) => !taken.has(slot(reading)))];
}

/**
 * Cached readings, validated.
 *
 * A cache file is on disk and could have been written by an older build, hand-edited, or truncated
 * mid-write. `posts.ts` validates its cache for the same reason; an unvalidated read here would put
 * whatever is in the file into an arithmetic sum.
 */
const readingsFrom: Parse<readonly MetricReading[]> = (value) =>
	z
		.array(
			z.object({
				kind: z.enum(METRIC_KINDS),
				window: z.enum(METRIC_WINDOWS),
				days: z.number().int().positive().optional(),
				value: z.number(),
				origin: z.enum(METRIC_ORIGINS),
				complete: z.boolean()
			})
		)
		.parse(value);

/** What one source contributed. */
interface Gathered {
	readonly readings: readonly MetricReading[];
	readonly ok: boolean;
	readonly reason: string | null;
}

/** One source's reported numbers, or why there are none. */
async function gather(source: ResolvedSource, cache: Cache): Promise<Gathered> {
	const provider = metricsSourceProvider(source.kind);
	const refusal = provider.unusable(source);

	// Asked before any request, so a source that can never answer says why immediately rather than
	// failing once per refresh forever. This is the path every platform except Bluesky takes today.
	if (refusal !== null) return { readings: [], ok: false, reason: refusal };

	const key = `metrics-${source.kind}-${source.id}`;
	const cached = await cache.get(key, readingsFrom);

	if (cached !== null && cached.age < REFRESH) {
		return { readings: cached.data, ok: true, reason: null };
	}

	try {
		const readings = await provider.read(source, context(cache));

		await cache.put(key, readings);

		return { readings, ok: true, reason: null };
	} catch (error) {
		// A failed read falls back to whatever this source last reported, exactly as the posts
		// orchestrator does: a stale follower count is worth more than an empty row.
		if (error instanceof SourceFailure) {
			return { readings: cached?.data ?? [], ok: false, reason: error.message };
		}

		// Anything that is not a `SourceFailure` is replaced rather than passed through. A transport
		// error's own message can carry a url with a token in its query string, and this is rendered
		// in the admin.
		log().error({ source: source.id, kind: source.kind, err: error }, 'reading metrics failed');

		return {
			readings: cached?.data ?? [],
			ok: false,
			reason: `Reading numbers from ${source.label} did not work.`
		};
	}
}

/** Posts grouped by the source that produced them, for the derived readings. */
function bySource(pieces: readonly ContentPiece[]): Map<string, ContentPiece[]> {
	const grouped = new Map<string, ContentPiece[]>();

	for (const piece of pieces) {
		if (piece.source === null) continue;

		const found = grouped.get(piece.source);

		if (found === undefined) grouped.set(piece.source, [piece]);
		else found.push(piece);
	}

	return grouped;
}

/**
 * Every platform's numbers, and the overall view.
 *
 * @param cache overridden by tests. Shared with nothing: the keys are namespaced so a metrics
 *   entry cannot collide with a posts entry in the same directory.
 */
export async function metrics(options: { readonly cache?: Cache } = {}): Promise<MetricsResult> {
	const config = feedConfig();
	const sources = feedSources(config);

	// Not `config.enabled`: that switch is about whether the *public feed* is shown, and an admin
	// looking at their own numbers has not asked about the public feed. The sources are configured
	// either way, which is what this reads.
	if (sources.length === 0) return NO_METRICS;

	const cache = options.cache ?? new Cache();

	// `audience: 'everything'` by name. This is the admin's own view of their own channels, so the
	// unlisted and private items count — and asking for it explicitly is what the default-public
	// rule in `./posts.ts` is for.
	const content = await posts({ cache, limit: 0, audience: 'everything' });
	const grouped = bySource(content.posts);

	const gathered = await Promise.all(sources.map((source) => gather(source, cache)));

	const platforms: PlatformMetrics[] = sources.map((source, index) => {
		const result = gathered[index] ?? { readings: [], ok: false, reason: null };
		const derived = derive(grouped.get(source.id) ?? []);

		return {
			platform: source.platform,
			label: source.label,
			readings: preferReported(result.readings, derived),
			ok: result.ok,
			reason: result.reason
		};
	});

	return {
		// Available when anything at all came back. A page saying "nothing yet" is a better answer
		// than a page of empty rows.
		available: platforms.some((platform) => platform.readings.length > 0),
		overall: consolidate(platforms),
		platforms
	};
}

export type { MetricKind, MetricWindow, MetricsResult, PlatformMetrics };
