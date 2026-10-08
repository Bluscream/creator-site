/**
 * Which provider reads which kind of source.
 *
 * **Every kind has a reader now**, so {@link PLANNED} is empty and {@link notYetRead} is reached by
 * nothing. Both stay, because what they are for has not happened yet rather than having stopped
 * being true: they are the machinery that makes adding the *next* kind a decision instead of an
 * omission. A test exercises `notYetRead` directly, since no kind reaches it any more.
 *
 * ### Why an unimplemented kind is a provider rather than a hole
 *
 * A kind with no reader still answers — with a provider whose `unusable` explains itself — rather
 * than being absent from the map.
 *
 * That is the difference between a feed that is honestly incomplete and one that is quietly wrong.
 * A missing entry would mean a configured source silently contributing nothing, which looks
 * identical to a platform that has gone quiet. A provider that says "no reader for this yet" puts
 * that sentence in the source's `reason`, where both the admin and the API show it. The
 * configuration is still accepted and kept, so adding the reader later needs no migration.
 *
 * It costs nothing at refresh time either: `unusable` is asked before any request is sent, so an
 * unimplemented source is skipped rather than attempted and failed once per interval forever.
 *
 * ### The two tables are a partition
 *
 * {@link READERS} and {@link PLANNED} between them must name every kind exactly once, and a test
 * asserts it. That is what makes adding a kind to `POST_SOURCE_KINDS` a decision rather than an
 * omission: whoever adds one has to either write its reader or say what will. Today the partition
 * happens to be the whole of one table and none of the other, which is the state it was aiming at.
 */

import { blueskySourceProvider } from './bluesky-source.js';
import { feedSourceProvider } from './feed-source.js';
import { kickSourceProvider } from './kick-source.js';
import { tiktokSourceProvider } from './tiktok-source.js';
import { twitchSourceProvider } from './twitch-source.js';
import { youtubeSourceProvider } from './youtube-source.js';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import type { PostSourceKind } from './posts-kinds.js';
import type { PostsSourceProvider } from './posts-source.js';

/** The kinds that can actually be read, and what reads them. */
const READERS: Readonly<Partial<Record<PostSourceKind, PostsSourceProvider>>> = {
	feed: feedSourceProvider,
	youtube: youtubeSourceProvider,
	bluesky: blueskySourceProvider,
	tiktok: tiktokSourceProvider,
	twitch: twitchSourceProvider,
	kick: kickSourceProvider
};

/**
 * The kinds that are configurable but not yet read, and what will read each.
 *
 * The value is a phrase completing "it will use …", so the message an admin sees says what is
 * coming rather than only what is missing.
 *
 * Empty, because every kind in `POST_SOURCE_KINDS` now has a reader. An entry belongs here when a
 * kind is added to the schema ahead of the code to read it — which is the supported order, and the
 * reason this table is not deleted along with its last row.
 */
const PLANNED: Readonly<Partial<Record<PostSourceKind, string>>> = {};

/**
 * A kind that is configurable but has no reader yet.
 *
 * Exported for its test: no kind reaches this through {@link postsSourceProvider} any more, and an
 * unreachable fallback that nothing exercises is one that quietly rots until the day it is needed.
 */
export function notYetRead(kind: PostSourceKind): PostsSourceProvider {
	const plan = PLANNED[kind];

	return {
		unusable: (): string =>
			plan === undefined
				? 'There is no reader for this kind of source.'
				: `Reading this source is not built yet — it will use ${plan}.`,

		read: (): never => {
			// Unreachable: the orchestrator asks `unusable` first and skips the source. Throwing
			// rather than returning an empty list, because an empty list would be a silently wrong
			// answer and reaching here at all is a programming error.
			throw new Error(`a ${kind} source has no reader and was read anyway`);
		}
	};
}

/** The provider for a kind. Total: every kind answers, even the ones with no reader. */
export function postsSourceProvider(kind: PostSourceKind): PostsSourceProvider {
	return READERS[kind] ?? notYetRead(kind);
}

/** The kinds that can actually be read, in declaration order. */
export function implementedKinds(): readonly PostSourceKind[] {
	return POST_SOURCE_KINDS.filter((kind) => READERS[kind] !== undefined);
}

/**
 * The kinds that are configurable and have a stated plan, in declaration order.
 *
 * Read from {@link PLANNED} rather than returned as the complement of {@link READERS}. That
 * distinction is the whole value of the partition test: a complement covers every kind by
 * construction, so asserting that the two lists add up would prove nothing. Taken from the table,
 * a kind added to `POST_SOURCE_KINDS` and then forgotten appears in neither list and the assertion
 * fails — which is what it is for.
 */
export function plannedKinds(): readonly PostSourceKind[] {
	return POST_SOURCE_KINDS.filter((kind) => PLANNED[kind] !== undefined);
}
