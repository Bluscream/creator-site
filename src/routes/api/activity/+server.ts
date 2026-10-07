/**
 * `GET /api/activity` — recent support activity, for the toasts.
 *
 * Replaces `main/api/activity.php`. Also reachable as `api.<domain>/activity`; see `src/hooks.ts`.
 *
 * The client remembers which ids it has already shown, so this stays a plain list rather than
 * growing a cursor: it only ever has to cover the last few seconds of activity.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { activity } from '#lib/server/activity.js';
import { notAllowed, serve } from '#lib/server/endpoint.js';
import { hasActivityProvider } from '#lib/server/providers/registry.js';

/** 10 seconds, as in the PHP. Under the 15s server cache, so a refetch can get new events. */
const BROWSER_CACHE = 10;

export const GET: RequestHandler = ({ url }) =>
	serve(
		{ browserCache: BROWSER_CACHE },
		() => activity({ force: url.searchParams.get('refresh') === '1' }),
		// The PHP endpoint was the one marked `requiresToken: true`, and this is that check: unlike
		// live status and chat, this feed needs a token, so a deployment with only a channel id gets
		// `configured: false` here and a working page everywhere else.
		hasActivityProvider()
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
