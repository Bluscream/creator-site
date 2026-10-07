/**
 * Turning whatever a platform returned into the one shape the UI draws.
 *
 * Every provider ends here, which is the point: the browser gets the same nine fields whether they
 * came out of a YouTube Atom entry, Twitch's Helix JSON or a TikTok embed payload, so there is one
 * row renderer rather than one per platform.
 *
 * Everything produced here is plain text bound for a text node or an image source. Nothing is
 * markup, so nothing downstream has to decide whether to trust it.
 */

import { platformFor } from '../../platforms.js';
import type { Post } from '../../posts.js';
import type { FeedSourceConfig } from '../feed-config.js';
import type { PostSourceKind } from './posts-kinds.js';

/** Trimmed to this before being stored, so a whole blog post does not land in the cache. */
const EXCERPT_LENGTH = 220;

/**
 * How close to the limit a word boundary has to be to be worth cutting on.
 *
 * Without a floor, a run of 220 characters with its last space at position 12 would be cut to one
 * word. Beyond this distance the mid-word cut is the better answer.
 */
const BOUNDARY_REACH = 40;

/**
 * One configured place to read posts from, resolved.
 *
 * Deliberately not validated beyond the shape every kind shares. What makes a *Twitch* target
 * valid is the Twitch provider's question, and asking it here would put every platform's rules in
 * one module again.
 */
export interface ResolvedSource {
	/** The slug from the configuration document; also what a post's id is prefixed with. */
	readonly id: string;

	/** Which provider reads this source. */
	readonly kind: PostSourceKind;

	/** A feed url, or a handle — whichever the kind means by it. */
	readonly target: string;

	/** What to call it on screen. */
	readonly label: string;

	/** A key of the platform registry, or null when it is not a known one. */
	readonly platform: string | null;
}

/**
 * A configured entry as a source to read.
 *
 * The platform is resolved rather than taken literally: `platformFor` tries the entry's own
 * `platform`, then the url's host, then the id, so `{ id: 'youtube', url: '@someone' }` needs no
 * annotation and a vanity domain can still be told what it is.
 */
export function resolveSource(entry: FeedSourceConfig): ResolvedSource {
	const platform = platformFor(entry);

	return {
		id: entry.id,
		kind: entry.kind,
		target: entry.url,
		label: entry.label ?? platform?.name ?? capitalise(entry.id),
		platform: platform?.key ?? null
	};
}

/**
 * Where this source's posts are cached.
 *
 * Keyed on what is actually fetched rather than on the source's id, so renaming a source keeps its
 * posts and repointing it at something else correctly starts cold.
 *
 * The null byte separates the two parts because it is the one character neither a kind nor a target
 * can contain. A plain `-` would let `kind: 'feed'` with target `x-y` and a hypothetical
 * `kind: 'feed-x'` with target `y` produce the same key, which is the kind of collision that would
 * serve one source's posts as another's. Nothing here has to be filesystem-safe — `Cache` hashes
 * every key before it becomes a path, so this only has to be unique.
 */
export function sourceCacheKey(source: ResolvedSource): string {
	return `feed-source\0${source.kind}\0${source.target}`;
}

/**
 * What a provider hands over: the platform's own values, before any normalising.
 *
 * Every optional field accepts `null` *and* `undefined`, which `exactOptionalPropertyTypes` treats
 * as distinct. Both occur in practice — a parsed feed gives `undefined` for an element that was
 * absent, and a JSON API gives `null` for a field it has no value for — so insisting on one would
 * make every provider normalise before it could even hand over.
 */
export interface RawPost {
	/** The platform's own id for this post. Prefixed with the source's id to make it unique. */
	readonly id: string;
	readonly url: string | null | undefined;
	readonly title?: string | null | undefined;
	readonly excerpt?: string | null | undefined;
	readonly image?: string | null | undefined;
	readonly publishedAt?: string | null | undefined;
	readonly author?: string | null | undefined;
}

/**
 * A raw post as a {@link Post}, or null when it is not one anybody can open.
 *
 * Null for a missing or non-`http` link rather than an empty string, because a row with nowhere to
 * go is worse than an absent row: it looks like content and does nothing.
 */
export function buildPost(source: ResolvedSource, raw: RawPost): Post | null {
	const url = raw.url;

	if (typeof url !== 'string' || !url.startsWith('http')) return null;

	return {
		id: `${source.id}:${raw.id}`,
		source: source.id,
		platform: source.platform,
		title: plain(raw.title) ?? '',
		url,
		excerpt: excerpt(raw.excerpt),
		image: image(raw.image),
		published_at: when(raw.publishedAt),
		author: plain(raw.author)
	};
}

/**
 * Collapsed whitespace, trimmed. Null in, null out.
 *
 * No entity decoding, which the PHP original did defensively. The feed parser already decodes
 * entities while parsing, and the API-backed providers return JSON strings that were never
 * encoded — so a decode here would be a second pass that turns a literal `&amp;` in somebody's
 * title into `&`, which is wrong and not recoverable.
 */
export function plain(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;

	return value.replaceAll(/\s+/gu, ' ').trim();
}

/**
 * Text split into what a reader would call characters.
 *
 * Grapheme clusters, not code units and not code points. The three differ exactly where social
 * posts live: `🦦` is two UTF-16 units, so counting units cuts it into unpaired halves — and
 * `👨‍👩‍👧` is a *single* cluster built from three emoji joined by zero-width joiners, so counting
 * code points cuts it into a man, a woman and a girl. That second failure is the worse one, because
 * it renders as something else entirely rather than as a broken character. The same applies to a
 * combining accent and to most Indic scripts.
 *
 * `Intl.Segmenter` is part of the runtime, so this is correct at no cost and no dependency.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function characters(text: string): readonly string[] {
	return [...GRAPHEMES.segment(text)].map((segment) => segment.segment);
}

/** A run of text cut to a readable length, with markup stripped first. */
export function excerpt(value: string | null | undefined): string {
	const text = plain(value === null || value === undefined ? null : stripTags(value));

	if (text === null || text === '') return '';

	const units = characters(text);

	if (units.length <= EXCERPT_LENGTH) return text;

	const head = units.slice(0, EXCERPT_LENGTH);
	const space = head.lastIndexOf(' ');

	// Cut on a word boundary when there is one near the limit, so the ellipsis does not land
	// mid-word — but not when the nearest one is far back, where keeping the word whole would mean
	// throwing away most of the excerpt to save it.
	const keep = space > EXCERPT_LENGTH - BOUNDARY_REACH ? head.slice(0, space) : head;

	return `${keep.join('').trimEnd()}…`;
}

/**
 * An image url, or null.
 *
 * `https` only, because this becomes an image source on a page served over it. A mixed-content
 * image is one the browser refuses anyway, so an `http` thumbnail is better dropped here — where
 * the row can fall back to text — than left to fail silently in the client.
 */
export function image(url: string | null | undefined): string | null {
	return typeof url === 'string' && /^https:\/\/[^\s<>"']+$/i.test(url) ? url : null;
}

/**
 * A timestamp as ISO 8601 in UTC, or null when it cannot be read.
 *
 * Providers hand over whatever their platform emits — RFC 3339 from Twitch, ISO 8601 from Bluesky,
 * anything at all from an arbitrary RSS feed — and the merged list is sorted on this string, so it
 * is normalised once here rather than trusted.
 */
export function when(value: string | null | undefined): string | null {
	if (value === null || value === undefined || value.trim() === '') return null;

	const parsed = new Date(value);

	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Markup removed.
 *
 * A feed's `description` is routinely a fragment of HTML, and this text is bound to a text node, so
 * the tags would otherwise be shown literally. Not a sanitiser and not trying to be one — nothing
 * downstream renders this as markup, so the job is only to stop `<p>` appearing in a sentence.
 */
function stripTags(value: string): string {
	return value.replaceAll(/<[^>]*>/gu, ' ');
}

/** First letter upper-cased, for a source id used as a label of last resort. */
function capitalise(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
