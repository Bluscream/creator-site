/**
 * Recent support activity, cached, from whichever provider this deployment uses.
 *
 * Ported from `Feed::supportActivity()`. The 15-second TTL is longer than chat's because a toast
 * arriving a few seconds late is unnoticeable, and the client dedupes by id — so a repeated poll
 * that returns the same twelve events shows nothing twice.
 */

import { NO_ACTIVITY } from '#lib/activity.js';
import type { Activity, ActivityResult } from '#lib/activity.js';
import { Cache } from '#lib/server/cache.js';
import { activityProvider } from '#lib/server/providers/registry.js';

const CACHE_KEY = 'support-activity';

/** 15 seconds, as in the PHP. */
const TTL = 15;

/**
 * 12 events, as the PHP endpoint asked for.
 *
 * `Feed::supportActivity()` defaulted to 10 and `api/activity.php` passed 12. The endpoint's number
 * is the one that was in use, so it is the one that is kept — and there is now one place to read it
 * from rather than two that disagree.
 */
export const ACTIVITY_LIMIT = 12;

export interface ActivityOptions {
	readonly cache?: Cache;
	readonly force?: boolean;
	readonly provider?: string;
	/** How many events to ask for. Defaults to {@link ACTIVITY_LIMIT}. */
	readonly limit?: number;
}

export async function activity(options: ActivityOptions = {}): Promise<ActivityResult> {
	const cache = options.cache ?? new Cache();
	const limit = options.limit ?? ACTIVITY_LIMIT;

	const entry = await cache.remember<Activity>(
		CACHE_KEY,
		TTL,
		() => activityProvider(options.provider).activity(limit),
		{ force: options.force ?? false }
	);

	return {
		...(entry.data ?? { ...NO_ACTIVITY, reason: entry.error }),
		age: Math.max(0, entry.age),
		stale: entry.stale
	};
}
