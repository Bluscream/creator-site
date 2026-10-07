/**
 * `GET /feed.atom` — the creator's posts from every platform, as one Atom feed.
 *
 * The syndication half of `/api/posts`. That endpoint answers the site's own page and reports per
 * source how the last read went; this answers a feed reader, which wants posts and nothing else.
 *
 * ### Why the origin comes from the request
 *
 * A feed has to state its own url, and nothing here is configured with one. `url.origin` is what
 * the request arrived as — `adapter-node` resolves it from `ORIGIN` or the forwarded headers — so a
 * single installation serves a correct feed on every hostname pointed at it, including a Tailscale
 * name and a tunnel, without a setting that can disagree with reality.
 *
 * ### Why the title lives in the feed document for now
 *
 * A feed must have a title. There is no site document yet to hold the creator's name, so the feed's
 * own `title` carries it and the host stands in when it is unset. When the site document exists
 * this should read from that instead; the fallback stays either way.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { feedConfig } from '#lib/server/feed.js';
import { notAllowed } from '#lib/server/endpoint.js';
import { posts } from '#lib/server/posts.js';
import { atom, titleFrom } from '#lib/server/syndication.js';

/**
 * How long a reader may reuse this, in seconds.
 *
 * Fifteen minutes rather than the page's one, because a feed reader polls on its own schedule and
 * there is no person waiting. The server's own per-source cache is what actually limits requests
 * upstream; this only limits how often a reader asks us.
 */
const BROWSER_CACHE = 900;

export const GET: RequestHandler = async ({ url }) => {
	// Everything, not the configured panel cap: a subscriber wants the feed, not a column.
	const result = await posts({ limit: 0 });

	if (!result.available) {
		// Not an error — the feed is switched off or has no sources. A reader should be told plainly
		// rather than handed an empty feed it will poll forever.
		return new Response('The post feed is not configured.', {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}

	const body = atom(result, {
		origin: url.origin,
		path: '/feed.atom',
		title: titleFrom(feedConfig().title, url.host)
	});

	return new Response(body, {
		headers: {
			'content-type': 'application/atom+xml; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'cache-control': `public, max-age=${String(BROWSER_CACHE)}, stale-while-revalidate=60`
		}
	});
};

/**
 * Anything that is not a GET.
 *
 * Unreachable in practice: SvelteKit's CSRF guard answers 403 to every non-GET before the route is
 * consulted. Kept so the method list is declared rather than implied, as on the `/api` routes.
 */
export const fallback: RequestHandler = () => notAllowed();
