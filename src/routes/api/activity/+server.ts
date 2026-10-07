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

/** Anything that is not a GET, with the same JSON envelope as every other response. */
export const fallback: RequestHandler = () => notAllowed();
