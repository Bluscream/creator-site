/**
 * Serving the API on `api.<domain>` as well as on `/api/`.
 *
 * §11.2 requires both to work, and requires them to be the *same* API rather than two surfaces that
 * drift. So there is one set of route files under `src/routes/api/`, and a request arriving on the
 * `api.` host has `/api` put in front of its path before SvelteKit matches it. Nothing downstream —
 * no handler, no test, no client — needs to know which hostname was used.
 *
 * Done as a rewrite rather than a redirect on purpose: a redirect would turn every API call into
 * two round trips, and would break a `POST` by dropping its body.
 */

/** The subdomain that means "this is the API". */
const API_HOST_PREFIX = 'api.';

/** The path prefix the routes actually live under. */
const API_PATH_PREFIX = '/api';

/** Whether this request arrived on the API hostname. */
export function isApiHost(url: URL): boolean {
	return url.hostname.toLowerCase().startsWith(API_HOST_PREFIX);
}

/**
 * The path to match this request against, or null when the host is not the API host.
 *
 * `api.example.com/live` becomes `/api/live`. `api.example.com/api/live` is left as `/api/live`
 * rather than becoming `/api/api/live`, because a client that wrote the prefix out on the API host
 * meant the same endpoint and should not get a 404 for being explicit.
 */
export function apiHostPath(url: URL): string | null {
	if (!isApiHost(url)) return null;

	const path = url.pathname;

	if (path === API_PATH_PREFIX || path.startsWith(`${API_PATH_PREFIX}/`)) return path;

	// A bare `api.example.com/` is the API's own root, not the site's front page: serving the links
	// page on the API hostname would be a second canonical URL for it.
	return `${API_PATH_PREFIX}${path === '/' ? '' : path}`;
}
