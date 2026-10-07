/**
 * `GET /api/events` — the one live stream, as Server-Sent Events.
 *
 * New in the rewrite: the PHP had no push transport and every live part of the page polled. §6 has
 * the reasoning for SSE over WebSockets; the short version is that the traffic is entirely
 * server→browser, SvelteKit 3 has no WebSocket support at all, and `EventSource` reconnects and
 * replays `Last-Event-ID` without a line of client code.
 *
 * ### `?topics=chat,activity,live`
 *
 * A client subscribes to what it can use. Absent means all of them. An unknown name is ignored
 * rather than refused, so a client built against a later version still gets the topics this
 * deployment does have.
 *
 * ### This endpoint does not require an event provider
 *
 * A deployment with no gateway configured gets a stream that connects, heartbeats and stays silent,
 * and its pages poll the REST endpoints as they always did. The alternative — refusing the
 * connection — would make every client branch on a deployment detail it cannot see, and would turn
 * "no gateway" into a visible error rather than a quieter page.
 *
 * ### Not under `serve()`
 *
 * Every other route returns one JSON envelope. This one returns a stream that stays open for hours,
 * so it shares nothing with `endpoint.ts` except the hostname rewrite.
 */

import { createResponse } from 'better-sse';
import type { RequestHandler } from '@sveltejs/kit';
import { topicsFrom } from '#lib/events.js';
import { notAllowed } from '#lib/server/endpoint.js';
import { register, sessionOptions } from '#lib/server/events.js';

export const GET: RequestHandler = ({ request, url }) => {
	const topics = topicsFrom(url.searchParams.get('topics'));

	return createResponse(request, sessionOptions(), (session) => {
		register(session, topics);
	});
};

/**
 * Anything that is not a GET.
 *
 * `EventSource` only ever issues a GET, so this is for a client doing something else — and it gets
 * the same JSON refusal as every other endpoint rather than SvelteKit's plain-text default.
 */
export const fallback: RequestHandler = () => notAllowed();
