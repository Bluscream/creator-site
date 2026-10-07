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

/** Anything that is not a GET, with the same JSON envelope as every other response. */
export const fallback: RequestHandler = () => notAllowed();
