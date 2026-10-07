/**
 * One way of getting posts out of a platform.
 *
 * ### Why this is a second kind of seam, beside the capability providers
 *
 * `types.ts` defines one interface per *capability*, and a deployment picks one implementation of
 * each — there is a single answer to "am I live". Posts are not like that: an installation reads
 * several sources at once, each from a different platform, and the whole point is that a creator
 * mixes them. So the unit here is a **source kind**, and the registry maps a kind to the reader for
 * it rather than choosing one.
 *
 * The capability seam still exists above this. `PostsProvider` in `types.ts` is "something that can
 * answer what this creator has posted", and the default implementation is the one that reads
 * configured sources through these. An installation that would rather pay an aggregator to answer
 * the whole question implements that interface instead and never touches this file.
 *
 * ### The contract
 *
 * - Return posts built through `buildPost`. An empty list is a fine answer: an account that has
 *   posted nothing is not an error.
 * - Throw {@link SourceFailure} with a message safe to show an admin. The orchestrator catches it,
 *   records it against that one source, and keeps serving whatever that source last returned — so
 *   a failure costs one platform's freshness, never the page.
 * - **Never put a credential in that message.** It is rendered in the editor, and a transport
 *   error's own message can contain a url with a token in its query string. That is why the
 *   orchestrator replaces anything that is not a `SourceFailure` rather than passing it through.
 */

import type { ContentPiece } from '../../posts.js';
import type { ResolvedSource } from './post.js';

/**
 * A failure with a message written to be shown to an admin.
 *
 * A distinct type rather than a plain `Error` precisely so the orchestrator can tell "the provider
 * explained what is wrong" from "something threw, and its message may contain anything". Only the
 * former is rendered.
 */
export class SourceFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SourceFailure';
	}
}

/** What a provider is given to do its work with. */
export interface SourceContext {
	/**
	 * Fetches, with the timeouts and headers every source should use.
	 *
	 * Provided rather than letting a provider call `fetch` itself so that the user agent, the
	 * redirect policy and the deadline are decided once. A provider that reached for the global
	 * `fetch` would quietly opt out of all three.
	 */
	fetch(
		url: string,
		init?: {
			readonly headers?: Readonly<Record<string, string>>;

			/**
			 * `POST` only, and only where a provider's *read* path needs one.
			 *
			 * Reading posts is a GET; this exists for the one case where it is not, an OAuth
			 * client-credentials grant, which is a POST by specification. Narrowed to the single verb
			 * on purpose — a provider reaching for `DELETE` is doing something this seam is not for.
			 */
			readonly method?: 'POST';

			/** Already encoded by the caller, since only the caller knows the content type. */
			readonly body?: string;
		}
	): Promise<Response>;

	/**
	 * A small store for values a provider works out rather than fetches.
	 *
	 * Separate from the per-source post cache, which the orchestrator owns. This is for the
	 * intermediate facts a provider needs first and that cost a request of their own: YouTube's feed
	 * is addressed by channel id while a person only knows their `@handle`, and Twitch's API wants a
	 * numeric broadcaster id while a person only knows their login.
	 *
	 * Those resolve to values that effectively never change, so caching them separately and for
	 * much longer than the posts is the difference between one extra request ever and one extra
	 * request per refresh — against endpoints that already throttle.
	 *
	 * Text only, deliberately: everything that belongs here is an identifier. A provider needing
	 * structured state should say why rather than widening this.
	 */
	readonly store: {
		/** The stored value and how old it is in seconds, or null when there is none. */
		get(key: string): Promise<{ readonly value: string; readonly age: number } | null>;

		put(key: string, value: string): Promise<void>;
	};
}

/** One way of reading a source. */
export interface PostsSourceProvider {
	/**
	 * Whether this provider can read the given source at all.
	 *
	 * Separate from {@link read} so a source that can never work — a Twitch source with no
	 * credentials configured, a handle that is not a handle — is reported as such without a request
	 * being made, and without waiting for the refresh interval to find out.
	 *
	 * @returns the reason it cannot, or null when it can
	 */
	unusable(source: ResolvedSource): string | null;

	/** The source's posts, newest-first order not required — the orchestrator sorts. */
	read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]>;

	/**
	 * How long this provider's image urls stay valid, in seconds. Absent means indefinitely.
	 *
	 * For a platform that signs its thumbnails with an expiry. A failed refresh falls back to the
	 * last good posts for as long as the failure lasts, which is deliberate and unbounded — a title,
	 * a link and a date do not go stale. A *signed* image url does: past its expiry it is a 404, and
	 * a row with a broken picture looks worse than the same row with no picture at all.
	 *
	 * So the orchestrator drops the image from a stale post once the cached entry is older than
	 * this, and keeps everything else. Declared by the provider because which urls expire is the
	 * platform's business, not the orchestrator's — this is the one thing it could not work out for
	 * itself, and the alternative was a list of hostnames somewhere central.
	 */
	readonly imageTtl?: number;
}
