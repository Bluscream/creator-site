import { describe, expect, it } from 'vitest';
import { NO_LIVE_STATUS, atom, offlinePlatform, watchUrl } from '#lib/live.js';

describe('where to watch a platform', () => {
	it.each([
		['twitch', 'someone', 'https://www.twitch.tv/someone'],
		['youtube', 'someone', 'https://www.youtube.com/@someone/live'],
		['tiktok', 'someone', 'https://www.tiktok.com/@someone/live'],
		['kick', 'someone', 'https://kick.com/someone'],
		['rumble', 'someone', 'https://rumble.com/c/someone']
	])('%s/%s → %s', (platform, handle, expected) => {
		expect(watchUrl(platform, handle)).toBe(expected);
	});

	it('returns null for a platform it does not know, rather than guessing', () => {
		// A guessed URL shape sends visitors to a 404, which is worse than omitting the link.
		expect(watchUrl('somethingnew', 'someone')).toBeNull();
	});

	it.each([[null], ['']])('returns null for the handle %o', (handle) => {
		expect(watchUrl('twitch', handle)).toBeNull();
	});
});

describe('a connected but offline platform', () => {
	it('is fully populated with everything off', () => {
		// It has to appear at all: the page lists every connected platform and marks which are live,
		// so an absent key and `live: false` are not interchangeable.
		expect(offlinePlatform('twitch', 'someone')).toStrictEqual({
			live: false,
			viewers: null,
			title: null,
			url: 'https://www.twitch.tv/someone',
			handle: 'someone',
			started_at: null,
			stream_id: null
		});
	});

	it('still appears when its watch URL cannot be worked out', () => {
		const state = offlinePlatform('somethingnew', 'someone');

		expect(state.url).toBeNull();
		expect(state.handle).toBe('someone');
	});
});

describe('normalising a timestamp', () => {
	// The format the PHP emitted and the recorded responses contain. `toISOString()` would add
	// milliseconds and a `Z`, which a client comparing strings would see as a difference.
	it('drops milliseconds and uses an explicit zero offset', () => {
		expect(atom('2026-10-07T04:07:08.123Z')).toBe('2026-10-07T04:07:08+00:00');
	});

	it('converts an offset to UTC rather than keeping it', () => {
		expect(atom('2026-10-07T06:07:08+02:00')).toBe('2026-10-07T04:07:08+00:00');
	});

	it('accepts a Date, because providers return both', () => {
		expect(atom(new Date('2026-10-07T04:07:08Z'))).toBe('2026-10-07T04:07:08+00:00');
	});

	it.each([[null], [undefined], [''], ['not a date'], ['2026-13-45']])(
		'returns null for %o rather than an Invalid Date',
		(value) => {
			expect(atom(value)).toBeNull();
		}
	);
});

describe('the empty status', () => {
	it('is a usable answer, not a hole', () => {
		// Served when nothing has ever been fetched successfully, so it has to render.
		expect(NO_LIVE_STATUS).toStrictEqual({ any_live: false, total_viewers: null, platforms: {} });
	});
});
