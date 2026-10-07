/**
 * `GET /api/live` — live state and viewer count per platform.
 *
 * Replaces `main/api/live.php`. Also reachable as `api.<domain>/live`; see `src/hooks.ts`.
 *
 * Which service answers is a deployment's choice — see `src/lib/server/providers/`. This route only
 * knows that *something* implements the live capability.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { notAllowed, serve } from '#lib/server/endpoint.js';
import { liveStatus } from '#lib/server/live.js';
import { hasLiveProvider } from '#lib/server/providers/registry.js';

/** 15 seconds, as in the PHP. Slightly under the 20s server cache, so a refetch can get new data. */
const BROWSER_CACHE = 15;

export const GET: RequestHandler = ({ url }) =>
	serve(
		{ browserCache: BROWSER_CACHE },
		() => liveStatus({ force: url.searchParams.get('refresh') === '1' }),
		hasLiveProvider()
	);

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
