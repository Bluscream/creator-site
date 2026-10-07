import { describe, expect, it } from 'vitest';
import { contrast, isHexColor } from '#lib/color.js';
import { hasIcon, icon, iconNames } from '#lib/icons.js';
import {
	detectPlatform,
	hasPlatform,
	iconFor,
	nameFor,
	platform,
	platformCss,
	platformFor,
	platformLabels,
	platforms
} from '#lib/platforms.js';

const all = platforms();

describe('the icon registry', () => {
	it('is not empty, so the checks below exercise something', () => {
		expect(iconNames().length).toBeGreaterThan(0);
	});

	it('draws something for a name nothing is registered under', () => {
		// Configuration is hand-edited: a typo should cost a wrong glyph, not a hole in a button.
		expect(icon('definitely-not-an-icon')).toStrictEqual(icon('link'));
	});

	it.each(iconNames())('%s is drawable', (name) => {
		const drawn = icon(name);

		if (drawn.kind === 'brand') {
			expect(drawn.path.length, `${name} has no path`).toBeGreaterThan(0);
			expect(isHexColor(drawn.hex), `${name} hex is ${drawn.hex}`).toBe(true);
			expect(drawn.title).not.toBe('');
		} else {
			expect(drawn.elements.length, `${name} has no elements`).toBeGreaterThan(0);

			for (const [tag, attrs] of drawn.elements) {
				expect(tag).not.toBe('');
				expect(Object.keys(attrs).length).toBeGreaterThan(0);
			}
		}
	});

	it('carries no markup, only elements and attributes', () => {
		// The chat builds every row with createElementNS and never innerHTML, because the same code
		// renders text a viewer typed. If a glyph ever arrived here as markup, that would stop being
		// a property of the code and start being a thing to remember.
		for (const name of iconNames()) {
			const drawn = icon(name);
			const payload = drawn.kind === 'brand' ? drawn.path : JSON.stringify(drawn.elements);

			expect(payload, `${name} contains a tag`).not.toContain('<');
		}
	});
});

describe('the platform registry', () => {
	it('registers every platform the old site knew', () => {
		// The keys are configuration's own vocabulary, so losing one silently unbrands every link
		// that used it.
		for (const key of [
			'youtube',
			'twitch',
			'tiktok',
			'instagram',
			'twitter',
			'threads',
			'discord',
			'vrchat',
			'synchra',
			'kick',
			'rumble',
			'bluesky',
			'owncast'
		]) {
			expect(hasPlatform(key), `${key} is missing`).toBe(true);
		}
	});

	it.each(all.map((entry) => entry.key))('%s resolves its icon', (key) => {
		const entry = platform(key);

		expect(entry).not.toBeNull();
		expect(hasIcon(entry?.icon ?? ''), `${key} draws ${String(entry?.icon)}`).toBe(true);
	});

	/**
	 * Only the platforms that have a colour.
	 *
	 * A platform with none recorded anywhere is a supported state — it just gets no brand fill — so
	 * the palette checks are driven by the filtered list rather than by a guard inside the case.
	 * Filtering means each generated case has a palette by construction, instead of containing a
	 * branch that asserts nothing and passes.
	 */
	const coloured = all.filter((entry) => entry.primary !== null);

	it('has at least one coloured platform, so the palette checks are not vacuous', () => {
		expect(coloured.length).toBeGreaterThan(0);
	});

	it.each(coloured)('$key has a usable palette', (entry) => {
		const { key, primary, ink, tintLight } = entry;

		expect(isHexColor(primary), `${key} primary is ${String(primary)}`).toBe(true);
		expect(isHexColor(ink), `${key} ink is ${String(ink)}`).toBe(true);
		expect(isHexColor(tintLight), `${key} tintLight is ${String(tintLight)}`).toBe(true);

		// A label on the brand fill is text, so it gets the text bar.
		expect(
			contrast(ink ?? '', primary ?? ''),
			`${key}: label ink on brand fill`
		).toBeGreaterThanOrEqual(4.5);

		// The light-theme mark is a glyph, so it gets the non-text bar (WCAG 1.4.11).
		expect(
			contrast(tintLight ?? '', '#ffffff'),
			`${key}: light-theme mark on white`
		).toBeGreaterThanOrEqual(3);
	});

	it('names every platform, and shortens none of them to nothing', () => {
		for (const entry of all) {
			expect(entry.name.trim(), `${entry.key} has no name`).not.toBe('');
			expect(entry.short.trim(), `${entry.key} has no short name`).not.toBe('');
		}
	});

	it('labels every platform for the picker', () => {
		expect(Object.keys(platformLabels())).toStrictEqual(all.map((entry) => entry.key));
	});

	it('records at least one host for each', () => {
		for (const entry of all) {
			expect(entry.hosts.length, `${entry.key} has no hosts`).toBeGreaterThan(0);
		}
	});

	it('gives no two platforms the same host', () => {
		const seen = new Map<string, string>();

		for (const entry of all) {
			for (const host of entry.hosts) {
				expect(seen.get(host), `${host} is claimed by ${String(seen.get(host))}`).toBeUndefined();
				seen.set(host, entry.key);
			}
		}
	});
});

describe('detecting a platform from a URL', () => {
	it.each([
		['https://youtube.com/@someone', 'youtube'],
		['https://www.youtube.com/watch?v=x', 'youtube'],
		['https://youtu.be/x', 'youtube'],
		['https://m.twitch.tv/someone', 'twitch'],
		['https://clips.twitch.tv/x', 'twitch'],
		['https://x.com/someone', 'twitter'],
		['https://bsky.app/profile/x', 'bluesky']
	])('%s → %s', (url, expected) => {
		expect(detectPlatform(url)?.key).toBe(expected);
	});

	it('matches a subdomain without it being listed', () => {
		// m.twitch.tv is listed nowhere; the suffix rule covers it.
		expect(detectPlatform('https://go.twitch.tv/x')?.key).toBe('twitch');
	});

	it('does not match a host that merely ends with the same letters', () => {
		// The reason the suffix check is on a dot boundary. `nottwitch.tv` is somebody else.
		expect(detectPlatform('https://nottwitch.tv/x')).toBeNull();
		expect(detectPlatform('https://evilyoutube.com/x')).toBeNull();
	});

	it.each([['not a url'], [''], ['mailto:someone@example.com'], ['/relative/path']])(
		'returns null for %o rather than throwing',
		(url) => {
			expect(detectPlatform(url)).toBeNull();
		}
	);

	it('returns null for a host nothing claims', () => {
		expect(detectPlatform('https://example.com/')).toBeNull();
	});
});

describe('resolving one configured link', () => {
	it('prefers an explicit platform over everything', () => {
		// The escape hatch, and the only thing that works for a URL that gives nothing away.
		expect(
			platformFor({ platform: 'twitch', url: 'https://youtube.com/x', id: 'youtube' })?.key
		).toBe('twitch');
	});

	it('ignores an explicit platform that is not registered', () => {
		expect(platformFor({ platform: 'myspace', url: 'https://youtube.com/x' })?.key).toBe('youtube');
	});

	it('falls back to the host', () => {
		expect(platformFor({ url: 'https://tiktok.com/@x' })?.key).toBe('tiktok');
	});

	it('falls back to the id when the host gives nothing away', () => {
		// The case this site actually has: a vanity redirect whose host says only the site's own
		// domain, so neither step 1 nor step 2 can help.
		expect(platformFor({ id: 'youtube', url: 'https://yt.example.com/' })?.key).toBe('youtube');
	});

	it('returns null for a link that is not a platform at all', () => {
		expect(platformFor({ id: 'about', url: 'https://example.com/about' })).toBeNull();
		expect(platformFor({})).toBeNull();
	});

	describe('its icon', () => {
		it("uses the entry's own, so a platform link may want a different glyph", () => {
			expect(iconFor({ platform: 'synchra', icon: 'chat' })).toBe('chat');
		});

		it("ignores an entry's icon that does not exist", () => {
			expect(iconFor({ platform: 'synchra', icon: 'nonsense' })).toBe('synchra');
		});

		it("uses the platform's, then the fallback", () => {
			expect(iconFor({ url: 'https://x.com/someone' })).toBe('twitter-x');
			expect(iconFor({ url: 'https://example.com/' })).toBe('link');
			expect(iconFor({ url: 'https://example.com/' }, 'heart')).toBe('heart');
		});
	});

	describe('its name', () => {
		it("uses the entry's own, then the platform's, then the fallback", () => {
			expect(nameFor({ name: 'My channel', url: 'https://youtube.com/x' })).toBe('My channel');
			expect(nameFor({ url: 'https://youtube.com/x' })).toBe('YouTube');
			expect(nameFor({ url: 'https://example.com/' })).toBe('');
			expect(nameFor({ url: 'https://example.com/' }, 'Link')).toBe('Link');
		});
	});
});

describe('the emitted custom properties', () => {
	const css = platformCss();

	it('emits a rule for every platform that has a colour', () => {
		for (const entry of all.filter((candidate) => candidate.primary !== null)) {
			expect(css, `${entry.key} has no rule`).toContain(`[data-platform="${entry.key}"]`);
		}
	});

	it('publishes all three properties per rule', () => {
		expect(css).toContain('--platform:');
		expect(css).toContain('--platform-ink:');
		expect(css).toContain('--platform-ink-light:');
	});

	it('is a stylesheet and nothing else', () => {
		// This is inlined into a page, so anything that could close the element matters. Every value
		// in it came from isHexColor-validated input, and this is the assertion that says so.
		expect(css).not.toContain('<');
		expect(css).not.toContain('</style');
		expect(css.match(/\{/g)?.length).toBe(css.match(/\}/g)?.length);
	});

	it('emits exactly one rule per coloured platform, and none for the rest', () => {
		// Stated as a count rather than as a loop over the colourless platforms, because there are
		// none today: that loop would have asserted nothing and passed, which is the failure
		// `requireAssertions` exists to catch. A count covers both directions and always runs.
		const coloured = all.filter((entry) => entry.primary !== null).length;

		expect(css.match(/\[data-platform=/g)?.length ?? 0).toBe(coloured);
	});
});
