import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { sequence } from '@sveltejs/kit/hooks';
import { startGateway } from '#lib/server/events.js';
import { SESSION_COOKIE, resolve as resolveSession } from '#lib/server/session.js';
import {
	baseLocale,
	cookieName,
	extractLocaleFromHeader,
	getTextDirection,
	isExcludedByRouteStrategy
} from '#lib/paraglide/runtime.js';
import { carriesNoLocale, localizedPath } from '#lib/i18n.js';
import { paraglideMiddleware } from '#lib/paraglide/server.js';

/**
 * Sends a first-time visitor to the page in their own language.
 *
 * Only ever for a plain page GET with no stored preference. Once a visitor has a language cookie —
 * which Paraglide sets the moment they pick one — their choice wins and this does nothing, so
 * someone deliberately reading the English site is not bounced out of it on every visit.
 */
const handleBrowserLanguage: Handle = async ({ event, resolve }) => {
	const { request, url, cookies } = event;

	const negotiable =
		request.method === 'GET' &&
		!isExcludedByRouteStrategy(url) &&
		carriesNoLocale(url) &&
		cookies.get(cookieName) === undefined;

	if (!negotiable) return resolve(event);

	const preferred = extractLocaleFromHeader(request);

	if (preferred !== undefined && preferred !== baseLocale) {
		return new Response(null, {
			status: 302,
			headers: {
				location: localizedPath(url, preferred),
				// Chosen by a request header: a cache that ignores that header would hand one
				// visitor's language to the next one.
				vary: 'Accept-Language'
			}
		});
	}

	// No redirect, but the decision still depended on the header, so the same caveat applies.
	const response = await resolve(event);
	response.headers.append('Vary', 'Accept-Language');

	return response;
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) =>
		resolve(
			{ ...event, request },
			{
				transformPageChunk: ({ html }) =>
					html
						.replace('%paraglide.lang%', locale)
						.replace('%paraglide.dir%', getTextDirection(locale))
			}
		)
	);

/**
 * Resolves who is signed in, once, for every request.
 *
 * Here rather than in each `load` for two reasons. A page that asks for the session itself is a page
 * that can forget to ask, and forgetting is the failure that matters; and the sliding renewal in
 * `session.resolve` should happen once per request rather than once per load function that happened
 * to look.
 *
 * The cookie is refreshed when the session renewed, so a browser that keeps visiting keeps a cookie
 * whose own expiry matches the row's. Without this the row would slide and the cookie would still
 * expire thirty days after it was issued, signing out somebody whose session was perfectly alive.
 */
const handleSession: Handle = ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	const session = token === undefined ? null : resolveSession(token);

	event.locals.principal = session?.principal ?? null;

	if (session !== null && token !== undefined) {
		event.cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			expires: new Date(session.expiresAt * 1000)
		});
	}

	return resolve(event);
};

export const handle: Handle = sequence(handleSession, handleBrowserLanguage, handleParaglide);

/**
 * Opens the upstream event connection, once, when the server starts.
 *
 * `init` rather than lazily on the first SSE connection: the gateway is also how the server learns
 * that a stream went live, and that has to work when nobody has the page open — otherwise the first
 * visitor after a broadcast starts sees an offline badge until a poll catches up.
 *
 * It never throws. A deployment with no event provider, or an upstream that is down, is a site that
 * polls — not a site that fails to boot.
 */
export const init: ServerInit = async () => {
	await startGateway();
};
