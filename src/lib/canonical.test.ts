/**
 * The shared layer every provider translates into.
 *
 * Small functions, and worth testing anyway: each one is a decision that used to be made
 * independently in five providers, and "the one place it is decided" is only true while they all
 * agree. The ones that earn their tests are {@link instantFrom}, which guesses a unit, and
 * {@link byNewest}, which has to put undated things somewhere.
 */

import { describe, expect, it } from 'vitest';
import {
	CONTENT_KINDS,
	MEDIA_KINDS,
	SEGMENT_KINDS,
	actorFrom,
	byNewest,
	expired,
	idFrom,
	instantFrom,
	showable
} from './canonical.js';
import type { Entity, Media } from './canonical.js';

/** An entity with only the field the sort looks at. */
function at(value: string | null): Entity {
	return { id: value ?? 'none', platform: null, source: null, at: value };
}

describe('actorFrom', () => {
	it('makes an actor from a name', () => {
		expect(actorFrom('Someone')).toStrictEqual({ name: 'Someone' });
	});

	it('keeps the rest of the fields', () => {
		expect(actorFrom('Someone', { handle: 'someone', colour: '#ff0000' })).toStrictEqual({
			name: 'Someone',
			handle: 'someone',
			colour: '#ff0000'
		});
	});

	it('is null for no name', () => {
		// A platform that will not say who said something should produce no actor at all, so a
		// renderer's null check is the whole decision.
		expect(actorFrom(null)).toBeNull();
	});

	it('is null for undefined', () => {
		expect(actorFrom(undefined)).toBeNull();
	});

	it('is null for an empty name', () => {
		expect(actorFrom('')).toBeNull();
	});

	it('is null for a name of only spaces', () => {
		// Which is what a feed with an empty `<author>` element gives, and would otherwise render as a
		// blank byline that looks like a bug.
		expect(actorFrom('   ')).toBeNull();
	});

	it('trims a name rather than refusing it', () => {
		expect(actorFrom('  Someone  ')?.name).toBe('Someone');
	});

	it('keeps a name that is only punctuation, which is somebody’s actual handle', () => {
		expect(actorFrom('...')?.name).toBe('...');
	});
});

describe('instantFrom', () => {
	it('keeps an ISO string, normalised to UTC', () => {
		expect(instantFrom('2026-03-04T05:06:07Z')).toBe('2026-03-04T05:06:07.000Z');
	});

	it('converts an offset to UTC', () => {
		expect(instantFrom('2026-03-04T05:06:07+02:00')).toBe('2026-03-04T03:06:07.000Z');
	});

	it('accepts a Date', () => {
		expect(instantFrom(new Date(Date.UTC(2026, 2, 4)))).toBe('2026-03-04T00:00:00.000Z');
	});

	it('reads a large number as milliseconds', () => {
		expect(instantFrom(1_772_600_767_000)).toBe('2026-03-04T05:06:07.000Z');
	});

	it('reads a small number as seconds', () => {
		// Which is what Twitch, TikTok and anything speaking unix time returns, and what a naive
		// `new Date(n)` would place in January 1970.
		expect(instantFrom(1_772_600_767)).toBe('2026-03-04T05:06:07.000Z');
	});

	it('puts the boundary where no real timestamp is ambiguous', () => {
		// Just below the floor is seconds: the year 56173, which nothing means.
		expect(instantFrom(999_999_999_999)).toBe(new Date(999_999_999_999_000).toISOString());

		// At the floor it is milliseconds: September 2001, which something might.
		expect(instantFrom(1_000_000_000_000)).toBe(new Date(1_000_000_000_000).toISOString());
	});

	it('is null for nothing', () => {
		expect(instantFrom(null)).toBeNull();
		expect(instantFrom(undefined)).toBeNull();
		expect(instantFrom('')).toBeNull();
	});

	it('is null rather than throwing for a date that is not one', () => {
		// A single malformed date in a feed of thirty entries should cost that entry its date, not the
		// whole feed.
		expect(instantFrom('last Tuesday')).toBeNull();
	});

	it('is null for NaN', () => {
		expect(instantFrom(Number.NaN)).toBeNull();
	});

	it('is null for a number past what a Date can hold', () => {
		expect(instantFrom(8.64e15 * 2)).toBeNull();
	});

	it('round-trips its own output', () => {
		// So a value that has been through a cache and back is unchanged, which is what keeps a cached
		// entity's id and sort position stable.
		const once = instantFrom(1_772_600_767);

		expect(instantFrom(once)).toBe(once);
	});
});

describe('idFrom', () => {
	it('prefixes the platform id with the source', () => {
		// Two platforms very easily use the same numeric id, and a client telling "already drawn" from
		// "new" by id would merge two unrelated things.
		expect(idFrom('youtube', '12345')).toBe('youtube:12345');
	});

	it('gives two sources with the same platform id different ids', () => {
		expect(idFrom('channel-a', '1')).not.toBe(idFrom('channel-b', '1'));
	});
});

describe('byNewest', () => {
	it('puts the newer first', () => {
		expect(
			[at('2026-01-01T00:00:00Z'), at('2026-06-01T00:00:00Z')].toSorted(byNewest)
		).toStrictEqual([at('2026-06-01T00:00:00Z'), at('2026-01-01T00:00:00Z')]);
	});

	it('puts an undated entry last', () => {
		// Not dropped: a platform that will not say when is still worth reading. Not first either — the
		// least informative rows should not be where the eye goes.
		const sorted = [at(null), at('2026-01-01T00:00:00Z')].toSorted(byNewest);

		expect(sorted[0]?.at).toBe('2026-01-01T00:00:00Z');
	});

	it('puts an undated entry last whichever order it arrived in', () => {
		const sorted = [at('2026-01-01T00:00:00Z'), at(null)].toSorted(byNewest);

		expect(sorted[1]?.at).toBeNull();
	});

	it('treats two undated entries as equal', () => {
		expect(byNewest(at(null), at(null))).toBe(0);
	});

	it('keeps several undated entries rather than collapsing them', () => {
		const entries = [
			{ ...at(null), id: 'a' },
			{ ...at('2026-01-01T00:00:00Z'), id: 'b' },
			{ ...at(null), id: 'c' }
		];

		expect(entries.toSorted(byNewest).map((entry) => entry.id)).toStrictEqual(['b', 'a', 'c']);
	});

	it('compares ISO strings chronologically, which is why `at` is a string', () => {
		// Lexical order and chronological order are the same for ISO 8601 in UTC. If that stops being
		// true, every list in the application is mis-sorted and nothing else would notice.
		expect(
			byNewest(at('2026-01-02T00:00:00.000Z'), at('2026-01-10T00:00:00.000Z'))
		).toBeGreaterThan(0);
	});

	it('sorts to the second, not just to the day', () => {
		const sorted = [at('2026-01-01T00:00:01.000Z'), at('2026-01-01T00:00:02.000Z')].toSorted(
			byNewest
		);

		expect(sorted[0]?.at).toBe('2026-01-01T00:00:02.000Z');
	});
});

describe('expired', () => {
	/** A picture, optionally with an expiry. */
	function picture(expiresAt?: number): Media {
		return {
			url: 'https://cdn.example/a.jpg',
			kind: 'image',
			...(expiresAt === undefined ? {} : { expiresAt })
		};
	}

	it('is false for media that does not expire', () => {
		expect(expired(picture())).toBe(false);
	});

	it('is false before the expiry', () => {
		expect(expired(picture(2000), 1000)).toBe(false);
	});

	it('is true after it', () => {
		expect(expired(picture(1000), 2000)).toBe(true);
	});

	it('is true at the exact second', () => {
		expect(expired(picture(1000), 1000)).toBe(true);
	});

	it('uses now when no time is given', () => {
		expect(expired(picture(1))).toBe(true);
	});
});

describe('showable', () => {
	const live: Media = { url: 'https://cdn.example/live.jpg', kind: 'image', expiresAt: 2000 };
	const dead: Media = { url: 'https://cdn.example/dead.jpg', kind: 'image', expiresAt: 500 };
	const forever: Media = { url: 'https://cdn.example/forever.jpg', kind: 'image' };

	it('keeps media that still works', () => {
		expect(showable([live], 1000)).toStrictEqual([live]);
	});

	it('drops media that has expired', () => {
		// A broken image is worse than no image: a layout hole and a failed request, when the text was
		// the part worth keeping.
		expect(showable([dead], 1000)).toStrictEqual([]);
	});

	it('keeps media with no expiry', () => {
		expect(showable([forever], 1000)).toStrictEqual([forever]);
	});

	it('keeps the order of what survives', () => {
		expect(showable([forever, dead, live], 1000)).toStrictEqual([forever, live]);
	});

	it('is empty for nothing', () => {
		expect(showable([], 1000)).toStrictEqual([]);
	});
});

describe('the declared vocabularies', () => {
	it('names the content kinds the platforms in scope actually produce', () => {
		// Asserted so adding one is a deliberate edit here rather than a string appearing in a provider
		// and quietly becoming part of the contract.
		expect(CONTENT_KINDS).toStrictEqual([
			'post',
			'video',
			'vod',
			'clip',
			'article',
			'stream',
			'other'
		]);
	});

	it('names the media kinds', () => {
		expect(MEDIA_KINDS).toStrictEqual(['image', 'video', 'audio']);
	});

	it('names the segment kinds', () => {
		expect(SEGMENT_KINDS).toStrictEqual(['text', 'emote', 'gift', 'mention', 'link']);
	});

	it('has an escape hatch for a kind nothing else describes', () => {
		// So a platform with something unusual is not forced into a wrong label, and nobody is tempted
		// to widen the type to `string`.
		expect(CONTENT_KINDS).toContain('other');
	});
});
