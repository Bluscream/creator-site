/**
 * Which provider reads which platform's numbers.
 *
 * The same partition as `posts-registry.ts`: {@link READERS} and {@link PLANNED} between them name
 * every source kind exactly once, and a test asserts it. Adding a kind is then a decision — write
 * its reader or say what will — rather than an omission that shows up as a platform silently
 * contributing nothing, which looks exactly like a platform with nothing to report.
 *
 * `Partial` on both, rather than a total `Record` on `PLANNED` that would make the compiler ask for
 * a plan whenever a kind is added: a kind that *gains* a reader has to leave the planned table, and
 * a total type forbids that. The partition test asks the question instead, in both directions.
 *
 * ### What is read today, and why the rest is not
 *
 * Everything that can be read without a credential is read. Bluesky serves
 * `app.bsky.actor.getProfile` unauthenticated; and every platform behind a GrayJay plugin answers
 * `getChannel` with a subscriber count, which covers `kick` and the nine platforms in the `grayjay`
 * table. Both also work on a *fan's* install, which holds no credentials at all — that is the
 * reason to prefer them over a linked-account reader even once one exists.
 *
 * What is left needs a credential. `youtube`, `twitch` and `tiktok` publish no follower count or
 * view total to an anonymous caller — Twitch's `/channels/followers` wants a broadcaster token and
 * `/users` stopped returning a view count — and `feed` carries no performance data at all, because
 * a syndication document is a list of posts and nothing else.
 *
 * So the honest state for those is "configurable, with a stated plan", in a sentence an admin can
 * read. The page is not thin in the meantime, because the orchestrator also *derives* what it can
 * from content the install has already fetched — see `../metrics.ts`. Derived numbers are labelled
 * as derived rather than presented as the platform's own, which is the difference between a page
 * that is honestly partial and one that is quietly wrong.
 */

import { blueskyMetricsProvider } from './bluesky-metrics.js';
import { grayjayMetricsProvider, kickMetricsProvider } from './grayjay-metrics.js';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import type { PostSourceKind } from './posts-kinds.js';
import type { MetricsSourceProvider } from './metrics-source.js';

/** The kinds whose numbers can actually be read, and what reads them. */
const READERS: Readonly<Partial<Record<PostSourceKind, MetricsSourceProvider>>> = {
	bluesky: blueskyMetricsProvider,
	kick: kickMetricsProvider,
	grayjay: grayjayMetricsProvider
};

/**
 * The kinds with no reader yet, and what each will use.
 *
 * The value completes "it will use …", so an admin sees what is coming rather than only what is
 * missing. Each one names the specific thing needed, because "not implemented" is not actionable
 * and "needs the YouTube Analytics API, which needs the channel linked" is.
 */
const PLANNED: Readonly<Partial<Record<PostSourceKind, string>>> = {
	feed: 'nothing — a syndication document is a list of posts and carries no performance data, so this kind is derived-only for good',
	youtube: 'the YouTube Analytics API, once the channel is linked',
	twitch: 'Twitch’s API with the broadcaster’s own token, once the channel is linked',
	tiktok: 'TikTok’s creator API, once the account is linked'
};

/**
 * A kind whose numbers are not read yet.
 *
 * Exported for its test, and because every kind reaches it today: an unexercised fallback is one
 * that rots until the day it is needed.
 */
export function notYetMeasured(kind: PostSourceKind): MetricsSourceProvider {
	const plan = PLANNED[kind];

	return {
		unusable: (): string =>
			plan === undefined
				? 'Numbers from this kind of source are not read.'
				: `Reading numbers from this platform is not built yet — it will use ${plan}.`,

		read: (): never => {
			// Unreachable: the orchestrator asks `unusable` first and skips the source. Throwing
			// rather than returning an empty list, because an empty list is a silently wrong answer
			// and arriving here at all is a programming error.
			throw new Error(`a ${kind} source has no metrics reader and was read anyway`);
		}
	};
}

/** The provider for a kind. Total: every kind answers. */
export function metricsSourceProvider(kind: PostSourceKind): MetricsSourceProvider {
	return READERS[kind] ?? notYetMeasured(kind);
}

/** The kinds whose numbers can be read, in declaration order. */
export function measuredKinds(): readonly PostSourceKind[] {
	return POST_SOURCE_KINDS.filter((kind) => READERS[kind] !== undefined);
}

/**
 * The kinds with a stated plan, in declaration order.
 *
 * Read from {@link PLANNED} rather than as the complement of {@link READERS}, for the reason the
 * posts registry gives: a complement covers every kind by construction, so asserting the two lists
 * add up would prove nothing. Taken from the table, a kind added to `POST_SOURCE_KINDS` and then
 * forgotten appears in neither and the partition test fails.
 */
export function plannedMetricKinds(): readonly PostSourceKind[] {
	return POST_SOURCE_KINDS.filter((kind) => PLANNED[kind] !== undefined);
}
