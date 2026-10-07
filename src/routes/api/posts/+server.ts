/**
 * `GET /api/posts` — the creator's posts from every configured source, merged, newest first.
 *
 * Replaces `main/api/posts.php`. Also reachable as `api.<domain>/posts`; see `src/hooks.ts`.
 *
 * ### `sources` is part of the answer, not diagnostics
 *
 * Every configured source is reported with how its last read went, including the ones that worked.
 * Listing only the failures would make a source that silently stopped being read indistinguishable
 * from one that was never configured — and it is what lets this ship while four of the five source
 * kinds have no reader yet: an unimplemented source says so in its own `reason` rather than going
 * quietly missing.
 *
 * A source can be `ok: false` with a non-zero `count`. That is not a contradiction: its last read
 * failed and it is still serving what it returned before. See `posts.ts` for why that is the point.
 *
 * ### `?limit=0`
 *
 * Zero means everything there is, which is what a whole feed page wants — no narrow column to keep
 * short, and no reason to discard posts already fetched and parsed. Absent means the configured
 * cap. This is what `posts-all.json` in the captured reference is: the same endpoint with no cap,
 * not a different set of sources.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { notAllowed, serve } from '#lib/server/endpoint.js';
import { posts } from '#lib/server/posts.js';

/**
 * A minute, as in the PHP.
 *
 * Longer than chat's four seconds because posts do not arrive while somebody is looking: the
 * server refreshes on its own interval, and a visitor reloading sooner than this would only be
 * asking the same sources the same question.
 */
const BROWSER_CACHE = 60;

/** A whole number from the query string, or undefined. Never `NaN`, and never negative. */
function whole(value: string | null): number | undefined {
	// Tested against the pattern rather than handed to `Number`, which accepts `' 12 '`, `'0x10'`,
	// `'1e3'` and `''` — none of which anybody meant to type in a limit.
	return value !== null && /^\d{1,4}$/.test(value) ? Number(value) : undefined;
}

export const GET: RequestHandler = ({ url }) => {
	const limit = whole(url.searchParams.get('limit'));

	return serve({ browserCache: BROWSER_CACHE }, () => posts(limit === undefined ? {} : { limit }));
};

/**
 * Anything that is not a GET.
 *
 * Normally unreachable, and kept anyway. SvelteKit's CSRF guard answers every non-GET to any route
 * with a plain 403 before the route is consulted — verified against a running build, for POST and
 * PUT, with and without a matching `Origin`. That is the right answer for an endpoint that only
 * reads, so it is not worked around; this stays as the backstop for the day that guard is
 * configured differently, and so the method list is declared rather than implied.
 */
export const fallback: RequestHandler = () => notAllowed();
