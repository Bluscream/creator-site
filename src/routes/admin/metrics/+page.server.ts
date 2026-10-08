/**
 * The numbers, consolidated.
 *
 * `admin` rather than the layout's `editor`: these are business figures. Not `owner`, unlike the
 * backup page — a backup is every session token and every stored credential, which is a different
 * kind of secret from "how the channel is doing", and an admin who runs the channel's day to day
 * needs these.
 *
 * **No public surface, deliberately.** `GET /api/metrics` serves the same three values to a program
 * behind the same `admin` guard, and that is the only other way to them. Even the numbers gathered
 * from a platform's own *public* endpoint stay behind it, because the aggregate is a picture the
 * creator did not publish even when every number in it was already findable somewhere.
 *
 * Read-only: there is nothing to submit, so there are no actions. A page with no actions is also a
 * page with nothing for the guard to be forgotten on.
 */

import { requireRole } from '#lib/server/auth/guard.js';
import { metrics } from '#lib/server/metrics.js';
import { measuredKinds, plannedMetricKinds } from '#lib/server/providers/metrics-registry.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireRole(locals, url, 'admin');

	return {
		metrics: await metrics(),

		// So the page can say what is coming rather than only what is here. Without this an install
		// whose platforms are all unread looks broken instead of early.
		measured: measuredKinds(),
		planned: plannedMetricKinds()
	};
};
