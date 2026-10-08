/**
 * Bluesky's follower and post counts, from the public AppView.
 *
 * The one platform here whose numbers need no credential: `app.bsky.actor.getProfile` is served
 * unauthenticated from `public.api.bsky.app` and returns `followersCount` and `postsCount`. That
 * makes this the provider that works in **both** deployment postures — a creator's own install and
 * a fan's install for a creator — which is exactly the case the metrics seam exists to support, so
 * it is worth having as the first real reader rather than a stub.
 *
 * `origin: 'platform'` rather than `third_party`: `public.api.bsky.app` is Bluesky's own service.
 * Unauthenticated is not the same as unofficial.
 *
 * ### What is deliberately not read
 *
 * `followsCount` — how many accounts the creator follows — comes back in the same response and is
 * not a performance metric. It is a fact about them, not about how their channel is doing, and a
 * metrics page that shows it is padding.
 *
 * Likes, views and replies are not in this response at all. Bluesky reports those per post, not per
 * account, and summing the ones in a feed page would be a number over "the posts this install
 * happened to read" — which is what the *derived* readings in `../metrics.ts` already are, labelled
 * as such. Presenting the same quantity here as a platform figure would be the quiet kind of wrong.
 */

import { z } from 'zod';
import { handleOf } from './bluesky-source.js';
import { SourceFailure } from './posts-source.js';
import type { MetricReading } from '../../metrics.js';
import type { MetricsSourceProvider } from './metrics-source.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

/** The public AppView, same host the posts reader uses. */
const API = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile';

const ADVICE = 'Set this source to a Bluesky handle, for example `someone.bsky.social`.';

/**
 * The two fields worth reading, both optional.
 *
 * Optional because the AppView omits a count it has not computed rather than sending zero, and a
 * schema that required them would turn a thin profile into a failure. An absent count is left out
 * of the readings entirely — a metric with no number is not a metric with the number zero.
 */
const profileSchema = z.object({
	followersCount: z.number().int().nonnegative().optional(),
	postsCount: z.number().int().nonnegative().optional()
});

export const blueskyMetricsProvider: MetricsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly MetricReading[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(ADVICE);

		const response = await context.fetch(
			`${API}?${new URLSearchParams({ actor: handle }).toString()}`
		);

		if (response.status === 400) {
			// What the AppView answers for a handle nobody holds — the one failure here an admin can
			// actually fix, so it is worth a sentence rather than a status code.
			throw new SourceFailure(`Bluesky has no account called ${handle}.`);
		}

		if (!response.ok) throw new SourceFailure(`Bluesky answered ${String(response.status)}.`);

		const parsed = profileSchema.safeParse(await response.json());

		if (!parsed.success) throw new SourceFailure('Bluesky sent something unexpected.');

		const readings: MetricReading[] = [];

		if (parsed.data.followersCount !== undefined) {
			readings.push({
				kind: 'followers',
				// A snapshot: it is true now and says nothing about any period.
				window: 'now',
				value: parsed.data.followersCount,
				origin: 'platform',
				complete: true
			});
		}

		if (parsed.data.postsCount !== undefined) {
			readings.push({
				kind: 'posts',
				// Everything the account has ever posted, which is what makes this worth having
				// beside the derived count: the derived one covers only the page that was fetched.
				window: 'all_time',
				value: parsed.data.postsCount,
				origin: 'platform',
				complete: true
			});
		}

		return readings;
	}
};
