/**
 * `GET /api/chat` — recent chat messages, oldest first.
 *
 * Replaces `main/api/chat.php`. Also reachable as `api.<domain>/chat`; see `src/hooks.ts`.
 *
 * Serving chat through here rather than framing the dashboard means the popup matches the site's
 * styling and keeps working if the dashboard's embed changes.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { notAllowed, serve } from '#lib/server/endpoint.js';
import { chat } from '#lib/server/chat.js';
import { hasChatProvider } from '#lib/server/providers/registry.js';

/** 4 seconds, as in the PHP. Just under the 5s server cache, so a refetch can get new messages. */
const BROWSER_CACHE = 4;

export const GET: RequestHandler = ({ url }) =>
	serve(
		{ browserCache: BROWSER_CACHE },
		() => chat({ force: url.searchParams.get('refresh') === '1' }),
		hasChatProvider()
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
