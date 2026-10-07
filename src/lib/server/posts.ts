/**
 * The creator's posts from every platform, merged into one list.
 *
 * Works out which sources are stale, asks their providers for them concurrently, merges what comes
 * back newest-first, and caches each source separately.
 *
 * ### Why each source is cached separately
 *
 * The obvious shape — one cache entry holding the merged list — has a failure mode this set of
 * platforms walks into constantly. YouTube's feed endpoint throttles by IP, and when it does it
 * answers **404, not 429**: the identical request returns 200 once and 404 twice twenty seconds
 * later. With one shared entry, a refresh that caught YouTube mid-throttle would overwrite fifteen
 * good videos with nothing, report the source merely unavailable, and then serve that empty list
 * for the rest of the interval.
 *
 * Per-source entries mean a throttled, rate-limited or briefly-broken platform keeps showing its
 * last good posts while every other source refreshes normally. That is why a source can report
 * `ok: false` and a non-zero `count` at the same time, and why `age` is the *oldest* entry's rather
 * than the newest.
 *
 * ### Why a failure never propagates
 *
 * Every source is read independently and a rejection is caught per source. One dead bridge costs
 * one platform's freshness and nothing else — not the other sources, and not the page.
 *
 * A provider's own {@link SourceFailure} carries a message written for an admin to read. Anything
 * else is a bug or a transport failure, and **its message can contain a url with a token in the
 * query string**, so it is logged and replaced rather than rendered. That ordering matters: asking
 * the generic question first would have answered it for `SourceFailure` too.
 */

import { z } from 'zod';
import { Cache } from './cache.js';
import type { Parse } from './cache.js';
import { feedConfig, feedSources } from './feed.js';
import { log } from './log.js';
import type { Post, PostSource, PostsResult } from '../posts.js';
import { NO_POSTS } from '../posts.js';
import { sourceCacheKey } from './providers/post.js';
import type { ResolvedSource } from './providers/post.js';
import { postsSourceProvider } from './providers/posts-registry.js';
import { SourceFailure } from './providers/posts-source.js';
import type { SourceContext } from './providers/posts-source.js';

/**
 * How long one source gets to answer.
 *
 * Short on purpose. Every source is read concurrently, so a refresh costs roughly the slowest
 * single response, and a bridge scraping a platform can hang for a long time. Whoever triggered
 * the refresh is waiting on it.
 */
const TIMEOUT_MS = 8000;

/**
 * The user agent every source request carries.
 *
 * The `Mozilla/5.0 (compatible; …)` form rather than a plain product token, because **YouTube's
 * feed endpoint answers 404 to anything that does not start that way**. It is not checking for a
 * real browser, it is checking for that prefix. The rest still says honestly what this is.
 */
const USER_AGENT =
	'Mozilla/5.0 (compatible; creator-site feed reader; +https://github.com/Bluscream/creator-site)';

const ACCEPT =
	'application/atom+xml, application/rss+xml, application/feed+json;q=0.9, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.7, */*;q=0.1';

/**
 * A cached entry, validated rather than trusted.
 *
 * The cache hands back JSON this code wrote, but not necessarily this *version* of it: an entry
 * survives a deployment, so a post shape that changed would otherwise flow out of a stale file and
 * into the UI, where a missing field is a rendering bug a long way from its cause. `Cache` treats a
 * parser that throws as a miss, so a stale-format entry is simply refetched.
 */
const cachedPosts: Parse<readonly Post[]> = (value) =>
	z
		.array(
			z.object({
				id: z.string(),
				source: z.string(),
				platform: z.string().nullable(),
				title: z.string(),
				url: z.string(),
				excerpt: z.string(),
				image: z.string().nullable(),
				published_at: z.string().nullable(),
				author: z.string().nullable()
			})
		)
		.parse(value);

/** What one source contributed, and how it went. */
interface Outcome {
	readonly posts: readonly Post[];
	readonly reason: string | null;
	readonly age: number | null;
}

/**
 * The context handed to every provider.
 *
 * The deadline, the headers and the redirect policy are decided here rather than by each provider,
 * so a provider contributed later cannot quietly opt out of any of them.
 */
function context(cache: Cache): SourceContext {
	return {
		async fetch(url, init) {
			return fetch(url, {
				// Forwarded so a provider whose read path needs a POST — an OAuth token grant — goes
				// through the same deadline and user agent as everything else rather than around it.
				...(init?.method === undefined ? {} : { method: init.method }),
				...(init?.body === undefined ? {} : { body: init.body }),
				headers: { 'user-agent': USER_AGENT, accept: ACCEPT, ...init?.headers },
				// Followed, but only to somewhere this would have gone anyway. `follow` is the
				// default; the cap is what stops a redirect loop costing the whole deadline.
				redirect: 'follow',
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
		},

		store: {
			async get(key) {
				// Namespaced, so a provider's keys cannot collide with the per-source post entries
				// or with another provider's.
				const entry = await cache.get(`source-store\0${key}`, asText);

				return entry === null ? null : { value: entry.data, age: entry.age };
			},

			async put(key, value) {
				await cache.put(`source-store\0${key}`, value);
			}
		}
	};
}

/** A stored identifier, validated so a cache entry of some other shape reads as a miss. */
const asText: Parse<string> = (value) => z.string().min(1).parse(value);

/**
 * A rejection as something safe to show an admin.
 *
 * See the note at the top: only a provider's own message is rendered.
 */
function reasonFor(error: unknown, source: ResolvedSource): string {
	if (error instanceof SourceFailure) return error.message;

	if (error instanceof Error && error.name === 'TimeoutError') {
		return 'The feed took too long to answer.';
	}

	log().error(
		{ source: source.id, kind: source.kind, err: error instanceof Error ? error.name : 'unknown' },
		'reading a post source failed'
	);

	return 'The feed could not be read.';
}

/**
 * One source: served from cache when fresh, read when not, and falling back when a read fails.
 *
 * The cache is read before `unusable` is asked, so a source that has become unreadable — a kind
 * whose reader was removed, a target that stopped being a url — still shows what it last returned
 * instead of going blank.
 */
async function readSource(source: ResolvedSource, cache: Cache, ttl: number): Promise<Outcome> {
	const key = sourceCacheKey(source);
	const entry = await cache.get(key, cachedPosts);
	const cached = entry?.data ?? [];

	// Fresh enough: no request at all for this one.
	if (entry !== null && entry.age < ttl) {
		return { posts: cached, reason: null, age: entry.age };
	}

	const provider = postsSourceProvider(source.kind);

	// Asked before anything is sent, so a source that can never work says so immediately instead of
	// failing once per refresh for the rest of time.
	const unusable = provider.unusable(source);

	if (unusable !== null) {
		return { posts: cached, reason: unusable, age: entry?.age ?? null };
	}

	try {
		const posts = await provider.read(source, context(cache));

		await cache.put(key, posts);

		return { posts, reason: null, age: 0 };
	} catch (error) {
		// The whole point of the per-source cache: a failed refresh falls back to whatever this
		// source last returned rather than contributing nothing.
		return { posts: cached, reason: reasonFor(error, source), age: entry?.age ?? null };
	}
}

/**
 * The merged posts, newest first.
 *
 * @param limit overrides the configured cap. Zero or less means everything there is, which is what
 *   a whole feed *page* wants — there is no narrow column to keep short, and no reason to throw
 *   away posts that have already been fetched and parsed.
 */
export async function posts(
	options: { readonly limit?: number; readonly ttl?: number; readonly cache?: Cache } = {}
): Promise<PostsResult> {
	const config = feedConfig();

	if (!config.enabled) return NO_POSTS;

	const sources = feedSources(config);

	if (sources.length === 0) return NO_POSTS;

	const cache = options.cache ?? new Cache();
	const ttl = options.ttl ?? config.refresh;
	const cap = options.limit ?? config.limit;

	// Concurrent, so the refresh costs roughly the slowest single source rather than the sum. Every
	// outcome is already a resolved value — `readSource` catches its own failures — so there is no
	// rejection here to lose the others to.
	const outcomes = await Promise.all(sources.map((source) => readSource(source, cache, ttl)));

	const merged: Post[] = [];
	const report: PostSource[] = [];
	let oldest = 0;

	for (const [index, source] of sources.entries()) {
		const outcome = outcomes[index];

		if (outcome === undefined) continue;

		merged.push(...outcome.posts);

		if (outcome.age !== null) oldest = Math.max(oldest, outcome.age);

		report.push({
			id: source.id,
			label: source.label,
			platform: source.platform,
			kind: source.kind,
			ok: outcome.reason === null,
			reason: outcome.reason,
			count: outcome.posts.length,
			age: outcome.age
		});
	}

	return {
		available: true,
		posts: capped(sorted(merged), cap),
		sources: report,
		age: oldest,
		// Stale when anything is being served from beyond its refresh interval — the throttled
		// source case at the top.
		stale: oldest >= ttl
	};
}

/**
 * Newest first.
 *
 * A post with no date sorts last rather than being dropped: plenty of feeds omit one, and
 * "undated" is still a post. `''` compares below every ISO timestamp, which is what puts them
 * there.
 */
function sorted(all: readonly Post[]): readonly Post[] {
	return [...all].sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
}

/** The first `limit`, or all of them when the limit is not positive. */
function capped(all: readonly Post[], limit: number): readonly Post[] {
	return limit > 0 ? all.slice(0, limit) : all;
}
