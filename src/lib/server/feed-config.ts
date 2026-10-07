/**
 * What the feed is allowed to be configured with.
 *
 * A zod schema rather than hand-written validation, and the same schema the admin will generate its
 * form from — which is what `Schema.php` does today. One declaration describes the field, its
 * bounds, its default and its editor control, so the three cannot drift.
 *
 * ### Why a bad entry is dropped rather than rejected
 *
 * `sources` is a list somebody edits by hand or through a form, and a half-filled row is a normal
 * intermediate state rather than a corrupt file. Each entry is therefore parsed independently and a
 * failing one becomes `null` and is filtered out: one unusable row costs that row, and the other
 * sources keep working. Rejecting the array would lose every source because one had a typo in its
 * id.
 *
 * This is the first layer of the two described in `document.ts`; the whole-document fallback there
 * is the backstop underneath it.
 */

import { z } from 'zod';
import { DEFAULT_POST_SOURCE_KIND, POST_SOURCE_KINDS } from './providers/posts-kinds.js';

/**
 * How long fetched posts are served before a refresh is attempted.
 *
 * Ten minutes by default. The floor is a minute because every refresh is a request per source to
 * somebody else's service, and the ceiling is a day because beyond that the page is an archive.
 */
export const DEFAULT_REFRESH = 600;

/** How many posts a panel shows when nothing says otherwise. */
export const DEFAULT_LIMIT = 24;

/**
 * A source's id, which is also what its posts' ids are prefixed with.
 *
 * Constrained because it appears in a post id and in a URL: lowercase, starting with a letter, and
 * short enough to read.
 */
const sourceId = z
	.string()
	.regex(
		/^[a-z][a-z0-9_-]{0,31}$/,
		'must be lowercase, start with a letter, and be 1–32 characters'
	);

/** One configured place to read posts from. */
const sourceSchema = z.object({
	id: sourceId,

	/**
	 * Which provider reads this source.
	 *
	 * Absent means an ordinary RSS or Atom feed, which is what most sources are and what every
	 * source was before some of them became APIs.
	 */
	kind: z.enum(POST_SOURCE_KINDS).default(DEFAULT_POST_SOURCE_KIND),

	/**
	 * A feed url, or a handle, depending on the kind.
	 *
	 * Called `url` for every kind because for most kinds that is what it is; the API-backed ones
	 * treat it as a handle and say so in their own hint. Deliberately not validated as a URL here —
	 * what makes a *Twitch* target valid is the Twitch provider's question, and answering it here
	 * would put every platform's rules back in one place.
	 */
	url: z.string().trim().min(1, 'is required'),

	/** What to call it on screen. Falls back to the platform's name, then to the id. */
	label: z.string().trim().min(1).optional(),

	/**
	 * A key of the platform registry, for the mark and the brand colour.
	 *
	 * Not validated against the registry here, and not required: `platformFor` resolves the
	 * platform from this, then the url's host, then the id, so most sources need not say it at all
	 * and an unrecognised value degrades to "not a known platform" rather than dropping the source.
	 */
	platform: z.string().trim().min(1).optional(),

	/**
	 * Configured but not read.
	 *
	 * Kept rather than deleted so a source that is temporarily broken upstream — a bridge that
	 * stopped working — can be parked without losing how it was set up.
	 */
	hidden: z.boolean().default(false)
});

/** One source as configured, after validation. */
export type FeedSourceConfig = z.output<typeof sourceSchema>;

/**
 * The whole feed document.
 *
 * Every field has a default, so an absent file is a working configuration with no sources — which
 * reports itself unavailable rather than failing.
 */
export const feedSchema = z.object({
	/** Absent means on, matching every other toggle. */
	enabled: z.boolean().default(true),

	/** How many posts a panel shows. Zero or less means no cap. */
	limit: z.number().int().min(0).max(100).default(DEFAULT_LIMIT),

	/** Seconds between refreshes of one source. */
	refresh: z.number().int().min(60).max(86_400).default(DEFAULT_REFRESH),

	/**
	 * What the published Atom and JSON feeds call themselves.
	 *
	 * Optional, and the syndication routes fall back to the request's host — a feed must have a
	 * title to be valid, and an installation that has not been told the creator's name should still
	 * publish a valid one. Capped because this lands in a `<title>` element, not because Atom says
	 * so.
	 *
	 * This belongs to the *feed* rather than the site only until there is a site document to put it
	 * in; see the note on the syndication routes.
	 */
	title: z.string().trim().min(1).max(200).optional(),

	/**
	 * The configured sources, in the order they should appear.
	 *
	 * Each entry is tolerated independently — see the note at the top. `.catch(null)` turns a
	 * failing entry into a hole, and the transform removes the holes, so the result is always a
	 * list of entries that parsed.
	 */
	sources: z
		.array(sourceSchema.nullable().catch(null))
		.default([])
		.transform((entries) => entries.filter((entry): entry is FeedSourceConfig => entry !== null))
});

/** The feed's configuration, after validation. */
export type FeedConfig = z.output<typeof feedSchema>;
