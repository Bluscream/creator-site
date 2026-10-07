/**
 * Live status, cached, from whichever provider this deployment uses.
 *
 * This file knows nothing about Synchra. It asks the registry for something that implements
 * `LiveProvider`, caches what comes back, and turns a failed refresh into a stale-but-usable
 * answer. Swapping the provider for Restream or Twitch changes nothing here — which is the test of
 * whether the seam is in the right place.
 *
 * The caching is the part worth keeping from `Feed::liveStatus()`: one upstream call per TTL no
 * matter how many people have the page open, and a previous value served with `stale: true` rather
 * than a blank panel when a refresh fails. A live badge twenty seconds out of date is worth far
 * more than no page.
 */

import { NO_LIVE_STATUS } from '#lib/live.js';
import type { LiveStatus, LiveStatusResult } from '#lib/live.js';
import { Cache } from '#lib/server/cache.js';
import { liveProvider } from '#lib/server/providers/registry.js';

const CACHE_KEY = 'live-status';

/** 20 seconds, as in the PHP. */
const TTL = 20;

export interface LiveStatusOptions {
	readonly cache?: Cache;
	/** Bypass the TTL. What a manual refresh button sends. */
	readonly force?: boolean;
	/** A provider id from configuration, when the operator has picked one. */
	readonly provider?: string;
}

export async function liveStatus(options: LiveStatusOptions = {}): Promise<LiveStatusResult> {
	const cache = options.cache ?? new Cache();

	const entry = await cache.remember<LiveStatus>(
		CACHE_KEY,
		TTL,
		// Resolved inside the refresh, not outside it: a cache hit should not need a provider at all,
		// so an unconfigured provider still serves a cached answer rather than refusing.
		() => liveProvider(options.provider).liveStatus(),
		{ force: options.force ?? false }
	);

	return {
		...(entry.data ?? NO_LIVE_STATUS),
		age: Math.max(0, entry.age),
		stale: entry.stale,
		error: entry.error
	};
}
