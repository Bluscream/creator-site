/**
 * `GET /api/metrics` — the same consolidated figures as `/admin/metrics`, for a program.
 *
 * The first guarded endpoint in the project, and the shape every other admin API route follows:
 * `requireRoleForApi` inside the reader, `visibility: 'private'`, and no browser cache.
 *
 * ### Why this exists at all
 *
 * Because the numbers are the thing somebody wants in a spreadsheet, a Grafana panel, or a weekly
 * message to themselves — and the only alternative to an endpoint is scraping the admin page, which
 * means handing a script a session cookie. An API token is narrower than a cookie in every
 * direction: it can be read-only, it can be listed, it can be rotated, and it can be revoked
 * without signing a person out of their own browser.
 *
 * ### Admin, exactly as the page is
 *
 * The aggregate is a picture the creator did not publish, even where every individual figure came
 * from a public third party. So this is the page's guard, not a weaker one — and it is `admin`
 * rather than `owner` for the same reason the page is: the people who are asked how the channel is
 * doing are the people who need it.
 *
 * ### The response is the page's data, not a second contract
 *
 * `metrics`, `measured` and `planned` are exactly what the page's `load` returns, because two
 * descriptions of one set of numbers is how they come to disagree. A client wanting the shape should
 * read `src/lib/metrics.ts`, which is where it is defined for both.
 */

import { metrics } from '#lib/server/metrics.js';
import { measuredKinds, plannedMetricKinds } from '#lib/server/providers/metrics-registry.js';
import { notAllowed, serve } from '#lib/server/endpoint.js';
import { requireRoleForApi } from '#lib/server/auth/guard.js';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = ({ locals }) =>
	serve(
		{
			// Zero, and `private` makes it moot. A figure that is fifteen minutes stale is already
			// what the orchestrator's own cache decides; a browser cache on top of that would mean a
			// creator who refreshes after fixing a source sees the old answer and concludes it did
			// not work.
			browserCache: 0,
			visibility: 'private'
		},
		async () => {
			// Inside the reader deliberately: `serve` turns the guard's 401 or 403 into this module's
			// JSON envelope with the same no-store headers, rather than letting SvelteKit answer an
			// API route with its own error page. See `endpoint.ts`.
			requireRoleForApi(locals, 'admin');

			return {
				metrics: await metrics(),
				measured: measuredKinds(),
				planned: plannedMetricKinds()
			};
		}
	);

/**
 * Anything that is not a GET.
 *
 * There is nothing here to write — metrics are read from the platforms, and a `POST` that
 * invalidated the cache would be a second way to spend somebody's rate limit. Declared rather than
 * implied, as in every other route.
 */
export const fallback: RequestHandler = () => notAllowed();
