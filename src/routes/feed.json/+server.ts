/**
 * `GET /feed.json` — the same posts as `/feed.atom`, as a JSON Feed.
 *
 * Two formats because readers are split: Atom is what everything understands, JSON Feed is what
 * anything written in the last decade would rather parse. They are generated from one list by one
 * module, so they cannot drift apart. See `/feed.atom` for why the origin comes from the request.
 *
 * Not to be confused with `/api/posts`, which is also JSON. That is this site's own UI contract —
 * an envelope, per-source status, a configurable cap. This is a syndication format with a
 * specification and a `version` url.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { feedConfig } from '#lib/server/feed.js';
import { notAllowed } from '#lib/server/endpoint.js';
import { posts } from '#lib/server/posts.js';
import { jsonFeed, titleFrom } from '#lib/server/syndication.js';

/** As `/feed.atom`: a reader polls on its own schedule and nobody is waiting. */
const BROWSER_CACHE = 900;

export const GET: RequestHandler = async ({ url }) => {
	const result = await posts({ limit: 0 });

	if (!result.available) {
		return new Response('The post feed is not configured.', {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}

	const feed = jsonFeed(result, {
		origin: url.origin,
		path: '/feed.json',
		title: titleFrom(feedConfig().title, url.host)
	});

	return new Response(JSON.stringify(feed), {
		headers: {
			// The type the JSON Feed specification asks for, which is not `application/json`.
			'content-type': 'application/feed+json; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'cache-control': `public, max-age=${String(BROWSER_CACHE)}, stale-while-revalidate=60`
		}
	});
};

/** As `/feed.atom`. */
export const fallback: RequestHandler = () => notAllowed();
