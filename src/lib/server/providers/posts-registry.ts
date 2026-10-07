/**
 * Which provider reads which kind of source.
 *
 * ### Why an unimplemented kind is a provider rather than a hole
 *
 * Four of the five kinds have no reader yet. Each still answers — with a provider whose `unusable`
 * explains itself — rather than being absent from the map.
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
 * omission: whoever adds one has to either write its reader or say what will.
 */

import { feedSourceProvider } from './feed-source.js';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import type { PostSourceKind } from './posts-kinds.js';
import type { PostsSourceProvider } from './posts-source.js';

/** The kinds that can actually be read, and what reads them. */
const READERS: Readonly<Partial<Record<PostSourceKind, PostsSourceProvider>>> = {
	feed: feedSourceProvider
};

/**
 * The kinds that are configurable but not yet read, and what will read each.
 *
 * The value is a phrase completing "it will use …", so the message an admin sees says what is
 * coming rather than only what is missing.
 */
const PLANNED: Readonly<Partial<Record<PostSourceKind, string>>> = {
	// Reduces to an Atom feed once the handle is resolved to a channel id, which needs a request of
	// its own — YouTube's feed endpoint takes an id, not a handle.
	youtube: 'the channel feed YouTube publishes',

	// Three requests on a cold cache: an app token, the broadcaster's numeric id, then the videos.
	twitch: 'the official Helix API',

	bluesky: 'the public Bluesky AppView',

	// One unauthenticated request to the page TikTok renders for embedding, which is server-rendered
	// with the post list already in it.
	tiktok: 'the TikTok embed page'
};

/** A kind that is configurable but has no reader yet. */
function notYetRead(kind: PostSourceKind): PostsSourceProvider {
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

/** The kinds that are configurable but not yet read, in declaration order. */
export function plannedKinds(): readonly PostSourceKind[] {
	return POST_SOURCE_KINDS.filter((kind) => READERS[kind] === undefined);
}
