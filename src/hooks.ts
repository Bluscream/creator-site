import type { Reroute } from '@sveltejs/kit/hooks';
import { deLocalizeUrl } from '#lib/paraglide/runtime.js';
import { apiHostPath } from '#lib/api-host.js';

/**
 * Which route file answers this URL.
 *
 * Two rewrites, and the order between them matters:
 *
 * 1. **`api.<domain>/live` → `/api/live`**, so the API is reachable on its own hostname without a
 *    second set of route files (§11.2).
 * 2. **`/de/chat` → `/chat`**, so a localised URL matches the one route that serves it.
 *
 * The API rewrite wins and returns immediately, because the API has no language of its own — the
 * locale strategy already excludes `/api/`, but on the API *hostname* the path has no `/api` prefix
 * yet at this point, so delocalising it first would let a path segment that happens to be a locale
 * name be stripped out of an API route.
 */
export const reroute: Reroute = ({ url }) => apiHostPath(url) ?? deLocalizeUrl(url).pathname;
