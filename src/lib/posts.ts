/**
 * The creator's posts from every platform, merged into one list.
 *
 * The item type is {@link ContentPiece} from `src/lib/canonical.ts`, re-exported here rather than
 * declared again. That is the point of the canonical layer: a post, a VOD, a clip and an uploaded
 * video are the same kind of thing, so they are the same type — and a row renderer written for one
 * draws all of them. This module is what the *posts capability* adds on top: how sources are
 * reported, how freshness is reported, and which tabs a feed UI offers.
 *
 * Everything in a piece is plain text bound for a text node or a URL bound for an attribute. Nothing
 * is markup, so nothing downstream has to decide whether to trust it.
 *
 * ### Why a piece has no `html` field, and no `tags`
 *
 * It is a link-in-bio row: a title, a picture, a date and somewhere to go. Carrying a platform's
 * full rendered body would mean sanitising five platforms' HTML to show something no row displays.
 * If a post page ever exists, that is the point to add it, with the sanitiser it needs.
 */

export type { Actor, ContentKind, ContentPiece, Media } from './canonical.js';

import type { ContentPiece } from './canonical.js';

/**
 * How one configured source's last fetch went.
 *
 * Reported for *every* source, including the ones that worked, because the alternative — listing
 * only failures — makes a source that silently stopped being read indistinguishable from one that
 * was never configured. This is also what makes it honest to ship a provider for some platforms
 * and not others: an unimplemented or unconfigured source says so here rather than going missing.
 */
export interface PostSource {
	/** The slug from the configuration document. */
	readonly id: string;

	/** What to call it on screen. */
	readonly label: string;

	/** A key of the platform registry, or null. */
	readonly platform: string | null;

	/** Which provider reads this source. */
	readonly kind: string;

	/** Whether the last attempt succeeded. */
	readonly ok: boolean;

	/**
	 * Why it did not, or null.
	 *
	 * Written to be shown to an admin, and therefore never containing a credential — a transport
	 * error's own message can carry the full request url, query string and token included, so those
	 * are logged and replaced rather than passed through.
	 */
	readonly reason: string | null;

	/** How many posts this source is contributing, which can be non-zero while `ok` is false. */
	readonly count: number;

	/** Seconds since this source's posts were fetched, or null when it has never answered. */
	readonly age: number | null;
}

/** The merged posts and the state of every source behind them. */
export interface Posts {
	/**
	 * Whether anything is configured at all.
	 *
	 * False with no sources, which is an ordinary state for a fresh install rather than a failure —
	 * the page says there is nothing configured instead of showing an error.
	 */
	readonly available: boolean;

	/** Newest first. A post with no date sorts last rather than being dropped. */
	readonly posts: readonly ContentPiece[];

	readonly sources: readonly PostSource[];
}

/** {@link Posts} with the freshness of the cache it came out of. */
export interface PostsResult extends Posts {
	/**
	 * Seconds since the *oldest* source was fetched.
	 *
	 * The oldest rather than the newest, because it is the honest answer to "how fresh is this
	 * list": one stale source makes the merged list partly stale, and reporting the freshest would
	 * hide exactly the case this is for.
	 */
	readonly age: number;

	/** Whether anything is being served from beyond its refresh interval. */
	readonly stale: boolean;
}

/** Nothing configured. */
export const NO_POSTS: PostsResult = {
	available: false,
	posts: [],
	sources: [],
	age: 0,
	stale: false
};

/**
 * One filter a feed UI offers.
 *
 * `platform` is null for the "everything" tab, which is also what a client reads as "do not
 * filter". The id is the platform key so a tab can be selected from a URL.
 */
export interface PostTab {
	readonly id: string;
	readonly label: string;
	readonly platform: string | null;
}

/** The id of the tab that filters nothing. No platform uses it. */
export const ALL_TAB = 'all';

/**
 * The tabs a feed UI shows: "everything", then one per platform that has a source.
 *
 * Derived from the sources rather than configured separately, so adding a source is all it takes to
 * get its tab and there is no second list to keep in step. Platforms appear in the order their
 * first source does, which is the order somebody arranged them in.
 *
 * Returns no tabs at all below two platforms: one tab beside "everything" showing the same posts is
 * a control with nothing to choose between. A source with no known platform — somebody's blog — has
 * nothing to label a tab with and lives only in "everything", so it never produces a tab but does
 * still contribute posts.
 *
 * @param all what to label the unfiltered tab, which is the caller's because it is a translated
 *   string and this module is not where messages live
 */
export function tabsFor(sources: readonly PostSource[], all: string): readonly PostTab[] {
	const byPlatform = new Map<string, PostTab>();

	for (const source of sources) {
		if (source.platform === null || byPlatform.has(source.platform)) continue;

		byPlatform.set(source.platform, {
			id: source.platform,
			label: source.label,
			platform: source.platform
		});
	}

	return byPlatform.size < 2
		? []
		: [{ id: ALL_TAB, label: all, platform: null }, ...byPlatform.values()];
}
