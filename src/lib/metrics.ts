/**
 * How a creator's channels are doing, in one shape.
 *
 * The numbers exist in a dozen dashboards and nowhere together, and "how is the channel doing" is a
 * question about all of them at once. So this is the canonical model for a measurement, the same way
 * `ContentPiece` is for a post: every provider translates into it, and the page draws one thing.
 *
 * Shared rather than server-only, because the admin page renders it.
 *
 * ### A reading, not a time series — yet
 *
 * The obvious model is a time series per metric per platform, and it is where this is going. It is
 * not where it starts, because the thing a page needs first is "what is the number now", and a
 * series that only ever holds one point is a more complicated way of saying that. {@link MetricPoint}
 * exists for when history does, and nothing here has to change shape to gain it.
 *
 * ### The window is the part that is easy to get wrong
 *
 * "Views" is not one number. A platform may report views *ever*, views *in the last 28 days*, or
 * viewers *right now*, and those are three different quantities that all arrive called views. Adding
 * an all-time count to a 28-day count produces a number that is not anything.
 *
 * So every reading carries a {@link MetricWindow}, and {@link consolidate} aggregates only readings
 * that agree on **both** the metric and the window. A platform that reports a window nothing else
 * does gets its own row rather than being folded into a wrong total.
 */

/** What is being measured. */
export const METRIC_KINDS = [
	/** People who asked to be told when this creator posts. */
	'followers',
	/** People paying for it, where the platform separates that from following. */
	'subscribers',
	/** Times something was watched or read. */
	'views',
	/** Approving reactions, under whatever name the platform uses. */
	'likes',
	/** Replies and comments. */
	'comments',
	/** Pieces of content. */
	'posts',
	/** Time spent watching, in seconds. */
	'watch_time',
	/** People watching at this moment. */
	'live_viewers'
] as const;

/** One of {@link METRIC_KINDS}. */
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * The period a reading describes.
 *
 * - `now` — a snapshot, true at the moment it was read. Follower counts, concurrent viewers.
 * - `all_time` — everything since the beginning. Total views on a video.
 * - `period` — a bounded recent window, whose length the provider states in {@link MetricReading.days}.
 */
export const METRIC_WINDOWS = ['now', 'all_time', 'period'] as const;

/** One of {@link METRIC_WINDOWS}. */
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

/** How a metric reads, for a renderer that has to label and format it. */
export interface MetricDefinition {
	/**
	 * What the number is counted in.
	 *
	 * `people` and `count` are both integers and are deliberately distinct: "1.2k followers" and
	 * "1.2k views" are the same formatting and not the same thing, and a page that says "1.2k" with
	 * no idea which is rendering a number without a noun.
	 */
	readonly unit: 'count' | 'people' | 'seconds';

	/**
	 * Whether adding this metric across platforms produces something meaningful.
	 *
	 * `true` for almost everything, and the exception is the point of the field existing: a metric
	 * that is a rate or an average cannot be summed, and the honest answer for one is to show it
	 * per platform and nothing overall. None of the current kinds are like that; the field is here
	 * because the first one that is will otherwise be summed by code that had no way to know.
	 */
	readonly additive: boolean;

	/**
	 * Whether a total across platforms counts the same person more than once.
	 *
	 * True for audience metrics: somebody who follows on two platforms is two followers in a sum,
	 * and a "total audience" that silently says otherwise is a number a creator might repeat in a
	 * sponsorship conversation. The page says so rather than the model pretending.
	 */
	readonly doubleCountsPeople: boolean;
}

/** What each kind is, for labelling and for {@link consolidate}. */
export const METRICS: Readonly<Record<MetricKind, MetricDefinition>> = {
	followers: { unit: 'people', additive: true, doubleCountsPeople: true },
	subscribers: { unit: 'people', additive: true, doubleCountsPeople: true },
	views: { unit: 'count', additive: true, doubleCountsPeople: false },
	likes: { unit: 'count', additive: true, doubleCountsPeople: false },
	comments: { unit: 'count', additive: true, doubleCountsPeople: false },
	posts: { unit: 'count', additive: true, doubleCountsPeople: false },
	watch_time: { unit: 'seconds', additive: true, doubleCountsPeople: false },
	live_viewers: { unit: 'people', additive: true, doubleCountsPeople: true }
};

/** One measurement at one time, for when history exists. Nothing produces these yet. */
export interface MetricPoint {
	/** ISO 8601, UTC. */
	readonly at: string;
	readonly value: number;
}

/** Where a number came from, which decides how much to trust it. */
export const METRIC_ORIGINS = [
	/** The platform said so, through its own API. */
	'platform',
	/** A third party that collects or publishes numbers about the platform. */
	'third_party',
	/** Worked out here from content this install had already read. */
	'derived'
] as const;

/** One of {@link METRIC_ORIGINS}. */
export type MetricOrigin = (typeof METRIC_ORIGINS)[number];

/** One number, from one platform. */
export interface MetricReading {
	readonly kind: MetricKind;
	readonly window: MetricWindow;

	/**
	 * How many days `window: 'period'` covers. Absent for the other windows.
	 *
	 * `| undefined` as well as optional, which `exactOptionalPropertyTypes` treats as distinct: a
	 * reading revived from a cache file comes back through zod's `.optional()`, which produces the
	 * `undefined` form, and the alternative was a parser that strips the key to satisfy a type that
	 * gains nothing from being narrower.
	 */
	readonly days?: number | undefined;

	readonly value: number;

	/** Where it came from. See {@link MetricOrigin}. */
	readonly origin: MetricOrigin;

	/**
	 * Whether this is everything there is of this metric for this platform.
	 *
	 * False for a derived number, which is the case that makes this necessary: total views summed
	 * over the posts in a feed is the total over *the posts this install has read*, not the
	 * channel's lifetime total. Presenting that as the channel's view count would be wrong by an
	 * unknowable margin, so the page says what it is instead.
	 */
	readonly complete: boolean;
}

/** Every number for one platform, and whether it could be read at all. */
export interface PlatformMetrics {
	/** The platform key, or null for a source with no platform of its own. */
	readonly platform: string | null;

	/** What to call it on screen. */
	readonly label: string;

	readonly readings: readonly MetricReading[];

	/** False when nothing could be read. The readings may still hold whatever was cached. */
	readonly ok: boolean;

	/** Why, in words safe to show an admin. Null when fine. */
	readonly reason: string | null;
}

/** One row of the overall view: the same metric and window, added across platforms. */
export interface MetricTotal {
	readonly kind: MetricKind;
	readonly window: MetricWindow;
	readonly days?: number;
	readonly value: number;

	/** How many platforms contributed. */
	readonly platforms: number;

	/** True only when every contributing reading was complete. */
	readonly complete: boolean;

	/**
	 * The origins that went into it.
	 *
	 * Carried because a total mixing a platform's own figure with a derived one is weaker than
	 * either, and a page that shows one number has to be able to say so.
	 */
	readonly origins: readonly MetricOrigin[];
}

/** Everything the metrics page draws. */
export interface MetricsResult {
	/** False when no source could contribute anything, which is not an error. */
	readonly available: boolean;

	/** Added across platforms. See {@link consolidate}. */
	readonly overall: readonly MetricTotal[];

	/** The same numbers, split by platform. */
	readonly platforms: readonly PlatformMetrics[];
}

/** Nothing configured, or nothing readable. Its own constant so every caller returns the same thing. */
export const NO_METRICS: MetricsResult = { available: false, overall: [], platforms: [] };

/**
 * The key a total is grouped by.
 *
 * Metric, window **and** period length. The last part matters: a 7-day figure and a 28-day figure
 * are both `window: 'period'` and adding them is meaningless, so they are different rows.
 */
function groupKey(reading: MetricReading): string {
	return `${reading.kind}|${reading.window}|${String(reading.days ?? '')}`;
}

/**
 * The overall view: readings added across platforms, grouped by metric and window.
 *
 * A metric whose definition says it is not {@link MetricDefinition.additive} is left out entirely
 * rather than summed — showing it per platform and nothing overall is the honest answer, and a
 * wrong total is worse than an absent one.
 *
 * Ordered by {@link METRIC_KINDS} so the page's rows do not move around as platforms come and go.
 */
export function consolidate(platforms: readonly PlatformMetrics[]): readonly MetricTotal[] {
	const groups = new Map<string, MetricTotal>();

	for (const platform of platforms) {
		for (const reading of platform.readings) {
			if (!METRICS[reading.kind].additive) continue;

			const key = groupKey(reading);
			const found = groups.get(key);

			if (found === undefined) {
				groups.set(key, {
					kind: reading.kind,
					window: reading.window,
					...(reading.days === undefined ? {} : { days: reading.days }),
					value: reading.value,
					platforms: 1,
					complete: reading.complete,
					origins: [reading.origin]
				});

				continue;
			}

			groups.set(key, {
				...found,
				value: found.value + reading.value,
				platforms: found.platforms + 1,

				// One incomplete contribution makes the total incomplete. There is no partial credit:
				// a sum containing an unknown is unknown.
				complete: found.complete && reading.complete,
				origins: found.origins.includes(reading.origin)
					? found.origins
					: [...found.origins, reading.origin]
			});
		}
	}

	return [...groups.values()].sort(
		(left, right) => METRIC_KINDS.indexOf(left.kind) - METRIC_KINDS.indexOf(right.kind)
	);
}
