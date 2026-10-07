/**
 * The one shape everything becomes.
 *
 * Every provider in this project translates into the types here, and nothing downstream knows which
 * platform a thing came from. A Bluesky post, a Twitch VOD and a TikTok video are all *a piece of
 * content with an author, a time, a body, a link and maybe a picture*; a Twitch chat message, a Kick
 * message and a Discord message are all *something somebody said, at a time, with badges*. Where
 * that is said once, adding a platform is writing a mapper. Where it is said per capability, adding a
 * platform is a mapper plus a renderer plus a type plus a feed format — which is what this module
 * replaces.
 *
 * ### What it fixed
 *
 * The capabilities had each invented their own vocabulary for the same three things, and the
 * divergence was invisible until they were written side by side:
 *
 * | concept | posts said | chat said | connections said |
 * | --- | --- | --- | --- |
 * | which platform | `platform` | `provider` | `platform` |
 * | when | `published_at` | `created_at` | `createdAt` |
 * | who | `author`, a string | `viewer` + three sibling fields | `handle` + two more |
 *
 * Three names for the platform, two for the timestamp, two casings, and "who" modelled three
 * different ways. A component could not be shared between them, which is why there were two.
 *
 * ### The rules this module keeps
 *
 * - **{@link Actor} is how anybody is described**, whoever they are. A post's author and a chat
 *   message's speaker are the same kind of thing; the difference is which fields a platform fills.
 * - **Time is always {@link Entity.at}**: ISO 8601, UTC, or null. Null is common and not an error —
 *   plenty of feeds omit a date, and a platform that does is not a platform to drop.
 * - **Nothing here is markup.** Everything is plain text bound for a text node or a URL bound for an
 *   attribute, so nothing downstream has to decide whether to trust it. A platform whose content is
 *   rich resolves it into {@link Utterance.parts} rather than handing over HTML.
 * - **The extension points are explicit.** A platform with a field nobody else has should not have
 *   to drop it, so each kind carries its own additions rather than everything being flattened into
 *   one wide optional-heavy record.
 *
 * This module is shared between server and client deliberately: it is the contract the API speaks,
 * so a component and a provider refer to the same declaration rather than two that agree today.
 */

/**
 * Somebody, on a platform.
 *
 * One type for a post's author, a chat message's speaker, a linked account's owner and a calendar
 * event's organiser. Everything but {@link Actor.name} is optional because which of these a platform
 * supplies varies wildly — an RSS feed gives a name and nothing else; Twitch chat gives a colour, an
 * avatar, a profile and badges — and a renderer that can draw the richest case degrades to the
 * poorest without a second code path.
 */
export interface Actor {
	/**
	 * What to call them, as the platform capitalises it.
	 *
	 * The one required field. An actor with no name is not an actor — a platform that will not say
	 * who said something should produce no actor at all rather than an empty one, so a renderer's
	 * `null` check is the whole decision.
	 */
	readonly name: string;

	/** The platform's own id, where there is one. Never shown; used to tell two same-named people apart. */
	readonly id?: string | undefined;

	/** The `@handle`, without the `@`, where the platform has one separate from the display name. */
	readonly handle?: string | undefined;

	/** An `https` avatar, or absent. Never copied or cached — it is somebody else's cdn. */
	readonly avatarUrl?: string | undefined;

	/** Their public profile page, or absent for a platform that has none. */
	readonly profileUrl?: string | undefined;

	/**
	 * The colour the platform assigns them, as a CSS colour, or absent.
	 *
	 * Chat platforms assign one per viewer and the effect is load-bearing: it is how a reader follows
	 * one person through a fast log. A renderer still has to make it legible against its own
	 * background, which is the renderer's problem rather than this one's.
	 */
	readonly colour?: string | undefined;

	/** Sub, mod and VIP icons, or absent. */
	readonly badges?: readonly Badge[] | undefined;
}

/** An icon beside somebody's name. */
export interface Badge {
	/** What it means, for a tooltip and for accessibility: "Moderator", "12-month subscriber". */
	readonly name: string;

	/** Which kind it is, so a renderer can style or drop a category: `moderator`, `subscriber`. */
	readonly type: string;

	/** An `https` image, or absent for a badge a renderer draws itself. */
	readonly imageUrl?: string | undefined;
}

/**
 * A picture or a video attached to something.
 *
 * `expiresAt` is why this is a type and not a URL. Several platforms sign their media URLs and they
 * stop working — TikTok's official cover images last six hours, its embed's last about forty-four —
 * so a cached entity can be perfectly good text with a dead picture. Carrying the expiry *with the
 * media* lets one rule drop the image and keep the text, rather than every provider declaring a
 * lifetime for every URL it ever produces.
 */
export interface Media {
	readonly url: string;

	/** What it is, so a renderer knows whether to use `<img>` or a poster plus a player. */
	readonly kind: MediaKind;

	/** Unix seconds the URL stops working, or absent where it does not. */
	readonly expiresAt?: number | undefined;

	/** Pixel dimensions, where the platform says, so a layout can reserve the space. */
	readonly width?: number | undefined;
	readonly height?: number | undefined;

	/** Alternative text, where the platform has it. Absent is not the same as empty. */
	readonly alt?: string | undefined;

	/** Whether it animates, so a client can respect `prefers-reduced-motion`. */
	readonly animated?: boolean | undefined;
}

/** What a {@link Media} is. */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const;

/** One of {@link MEDIA_KINDS}. */
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * What everything that comes out of a provider has.
 *
 * Four fields, and the reason each is here rather than per capability is that every renderer, every
 * cache key and every feed format needs all four.
 */
export interface Entity {
	/**
	 * Stable across refreshes, and unique across platforms.
	 *
	 * Prefixed with where it came from, because two platforms very easily use the same numeric id and
	 * a client telling "already drawn" from "new" by id would then merge two unrelated things.
	 */
	readonly id: string;

	/**
	 * A key of the platform registry, or null for something that is not a known platform.
	 *
	 * Null is ordinary: somebody's own blog is a real source with no platform. A renderer uses it for
	 * an icon and a filter, so null means "no icon" rather than "broken".
	 */
	readonly platform: string | null;

	/**
	 * Which configured source produced it, by its id, or null for something not read from a source.
	 *
	 * Separate from {@link platform} because one platform can be configured twice — two YouTube
	 * channels — and a filter by platform and a filter by source are different questions.
	 */
	readonly source: string | null;

	/**
	 * When it happened. ISO 8601, UTC, or null.
	 *
	 * Null for the many feeds that omit a date. Sorted last rather than dropped: a platform that will
	 * not say when is still a platform worth reading.
	 */
	readonly at: string | null;
}

/** What kind of thing a {@link ContentPiece} is. */
export const CONTENT_KINDS = [
	/** A short post: Bluesky, Mastodon, Threads, X. */
	'post',
	/** An uploaded video: YouTube, TikTok. */
	'video',
	/** A past broadcast. */
	'vod',
	/** A clip somebody cut from a broadcast. */
	'clip',
	/** A written article, from a blog or a feed. */
	'article',
	/** A live broadcast, happening now. */
	'stream',
	/** Anything a platform offers that none of the above describes. */
	'other'
] as const;

/** One of {@link CONTENT_KINDS}. */
export type ContentKind = (typeof CONTENT_KINDS)[number];

/**
 * A piece of content: a post, a video, a VOD, a clip, an article.
 *
 * One type for all of them, because a feed row draws the same things in the same places whichever it
 * is. {@link ContentPiece.kind} is for an icon and a label, not for choosing a renderer — the moment
 * it chooses a renderer, there is one renderer per platform again.
 */
export interface ContentPiece extends Entity {
	readonly kind: ContentKind;

	/**
	 * Never null: a piece with no title of its own renders with its first line, and nothing is `''`
	 * only when there is genuinely no text at all.
	 *
	 * May equal the whole {@link body}. Bluesky and TikTok have no title field, so the first line of
	 * the text stands in — and for a short post the first line *is* the text. A renderer drawing both
	 * must therefore skip the body when it repeats the title rather than printing it twice; that is
	 * the renderer's decision, which is why nothing is blanked here.
	 */
	readonly title: string;

	/** Where it is. Always `https` — a piece of content with no link is not one. */
	readonly url: string;

	/** Markup stripped, entities decoded, cut to a readable length. `''` when there is none. */
	readonly body: string;

	/** Who made it, or null when the platform does not say. */
	readonly author: Actor | null;

	/**
	 * Pictures and videos, in the order the platform gave them.
	 *
	 * A list rather than one image because several of these platforms attach up to four, and a type
	 * that holds one forces the provider to decide which matters — a decision the renderer is better
	 * placed to make. Empty is ordinary.
	 */
	readonly media: readonly Media[];
}

/**
 * Something somebody said: a chat message, a comment, a notice.
 *
 * Separate from {@link ContentPiece} because the questions are different — an utterance has no title
 * and no permalink, and it has resolved parts because a chat message is text interleaved with emotes
 * that a platform describes as ranges. What it shares is {@link Entity} and {@link Actor}, which is
 * what makes a row renderer shareable between a chat log and a comment thread.
 */
export interface Utterance extends Entity {
	/** Who said it. Required: an utterance from nobody is not one. */
	readonly author: Actor;

	/** Plain text, for a title attribute, for a search, and for accessibility. */
	readonly text: string;

	/**
	 * The same content as drawable pieces.
	 *
	 * Resolved by the provider rather than by the renderer, because only the provider knows that
	 * platform's emote syntax — and a renderer that parsed it would be a renderer per platform.
	 */
	readonly parts: readonly Segment[];

	/**
	 * Which kind of event this is, or null for something somebody typed.
	 *
	 * A gift, a subscription or a raid arrives through a chat feed as a notice, and a client styles it
	 * apart. Non-null is the whole signal; the string names the kind for the label.
	 */
	readonly notice: string | null;
}

/** What a {@link Segment} is. */
export const SEGMENT_KINDS = ['text', 'emote', 'gift', 'mention', 'link'] as const;

/** One of {@link SEGMENT_KINDS}. */
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * One drawable piece of an {@link Utterance}.
 *
 * A plain `imageUrl` rather than a {@link Media}, which is the one place this module does not reuse
 * its own richer type, and deliberately. An emote url is a cdn path with no expiry, no dimensions
 * and no alt text other than the emote's name, so a `Media` here would be four absent fields — and
 * this shape is **structurally identical to what a provider library already resolves**. `synchra-ts`
 * parses a platform's emote ranges into exactly `{ kind, text, imageUrl?, animated?, href? }`, so
 * its result is assignable with no mapper. Reimplementing that resolution to get a prettier field
 * name would be the wheel-reinvention this project avoids; {@link Badge} is the same bargain.
 *
 * A renderer walks the list once and switches on `kind`: draw `text`, or draw `imageUrl` with `text`
 * as its alt, or draw a link to `href`. `text` is always set, which is what makes a plain-text
 * fallback, a title attribute and a screen reader work without a second code path.
 */
export interface Segment {
	readonly kind: SegmentKind;

	/** The text, or the emote's name, or the link's label. Never empty. */
	readonly text: string;

	/** For an emote or a gift: the image to draw instead of the text. */
	readonly imageUrl?: string | undefined;

	/** Whether that image animates, so a client can respect `prefers-reduced-motion`. */
	readonly animated?: boolean | undefined;

	/** For a link: where it points. For a mention: the mentioned actor's profile. */
	readonly href?: string | undefined;
}

/**
 * An actor, or null when there is no name to show.
 *
 * The one place "is there an author" is decided, so every provider agrees. A platform that returns
 * an empty string, a string of spaces, or the literal word it uses for "deleted user" should produce
 * null — a renderer's `null` check is then the whole decision, rather than each renderer also
 * guarding against a blank name.
 */
export function actorFrom(
	name: string | null | undefined,
	rest: Omit<Actor, 'name'> = {}
): Actor | null {
	const trimmed = (name ?? '').trim();

	return trimmed === '' ? null : { name: trimmed, ...rest };
}

/**
 * A timestamp as {@link Entity.at} wants it, or null.
 *
 * Accepts what providers actually have: an ISO string, unix seconds, unix milliseconds, or a `Date`.
 * Unix seconds and milliseconds are told apart by magnitude, because a platform that returns one
 * rarely documents which — the boundary is the year 2001 in milliseconds, which is also the year
 * 33658 in seconds, so no real timestamp is ambiguous.
 *
 * Anything unparseable is null rather than an exception: a single malformed date in a feed of thirty
 * entries should cost that entry its date, not the whole feed.
 */
export function instantFrom(value: string | number | Date | null | undefined): string | null {
	if (value === null || value === undefined || value === '') return null;

	const date = typeof value === 'number' ? new Date(scaled(value)) : new Date(value);

	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Seconds below this are too small to be milliseconds anybody means. See {@link instantFrom}. */
const MILLISECOND_FLOOR = 1_000_000_000_000;

/** A number as milliseconds, whichever unit it arrived in. */
function scaled(value: number): number {
	return Math.abs(value) < MILLISECOND_FLOOR ? value * 1000 : value;
}

/**
 * An id for something, prefixed with where it came from.
 *
 * `source:platformId`. The separator is a colon because no platform's own id contains one in
 * practice, and because the result is readable in a log — which matters more than it sounds when the
 * alternative is comparing two opaque strings to find out why a list has duplicates.
 */
export function idFrom(source: string, platformId: string): string {
	return `${source}:${platformId}`;
}

/**
 * Newest first, with undated things last.
 *
 * The one ordering, because every list of these is shown newest first and a list that sorted undated
 * entries to the top would put the least informative rows where the eye goes. Comparing ISO strings
 * lexically is comparing them chronologically, which is the reason {@link Entity.at} is a string.
 */
export function byNewest<T extends Entity>(a: T, b: T): number {
	if (a.at === null) return b.at === null ? 0 : 1;
	if (b.at === null) return -1;

	return b.at.localeCompare(a.at);
}

/**
 * The one picture to show for a piece of content, or null.
 *
 * The first image, which is the order the platform gave them in and therefore the one it considers
 * primary. A helper rather than `piece.media[0]` at every call site, because "which of four images
 * is the thumbnail" is a decision and it should have one answer — and because a row renderer and a
 * feed generator picking differently is the kind of inconsistency nobody notices for months.
 */
export function pictureOf(piece: { readonly media: readonly Media[] }): Media | null {
	return piece.media.find((entry) => entry.kind === 'image') ?? null;
}

/** Whether a piece of media has stopped working. */
export function expired(media: Media, at: number = Math.floor(Date.now() / 1000)): boolean {
	return media.expiresAt !== undefined && media.expiresAt <= at;
}

/**
 * The media that is still worth rendering.
 *
 * Applied where a cached entity is served, so stale text keeps its words and loses its dead
 * pictures. A broken image is worse than no image: it is a layout hole and a failed request, and the
 * text was the part worth keeping.
 */
export function showable(media: readonly Media[], at?: number): readonly Media[] {
	return media.filter((entry) => !expired(entry, at));
}
