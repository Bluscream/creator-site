import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { sequence } from '@sveltejs/kit/hooks';
import { startGateway } from '#lib/server/events.js';
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

export const handle: Handle = sequence(handleBrowserLanguage, handleParaglide);

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
