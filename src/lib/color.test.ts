import { describe, expect, it } from 'vitest';
import {
	GLYPH_CONTRAST,
	TEXT_CONTRAST,
	contrast,
	isHexColor,
	isReadableText,
	luminance,
	onLight,
	readableInk
} from '#lib/color.js';

describe('recognising a colour literal', () => {
	it.each([['#ff0000'], ['#FF0000'], ['#0b0e14'], ['#ffffff']])('accepts %s', (value) => {
		expect(isHexColor(value)).toBe(true);
	});

	// This is validated rather than escaped because it lands in a `style` attribute, where escaping
	// is not the check that matters: an HTML-escaper passes through anything that is not a colour.
	it.each([['red'], ['#fff'], ['#ff00000'], ['rgb(1,2,3)'], [''], ['#ff00gg'], [null], [12]])(
		'rejects %o',
		(value) => {
			expect(isHexColor(value)).toBe(false);
		}
	);

	it('rejects a CSS expression that would escape the attribute', () => {
		expect(isHexColor('red;background:url(javascript:alert(1))')).toBe(false);
	});
});

describe('picking a readable ink', () => {
	it('puts white on a dark fill and near-black on a light one', () => {
		expect(readableInk('#000000')).toBe('#ffffff');
		expect(readableInk('#ffffff')).toBe('#0b0e14');
	});

	it("puts white on Twitch's purple and near-black on X's white", () => {
		// The pair that is the whole reason nothing hard-codes a label colour: either as a constant
		// makes the other invisible.
		expect(readableInk('#9146ff')).toBe('#ffffff');
		expect(readableInk('#ffffff')).toBe('#0b0e14');
	});

	it('always picks the better of the two, so the answer is never the worse one', () => {
		for (const fill of ['#ff0000', '#53fc19', '#5865f2', '#808080', '#2f024f', '#00f2fe']) {
			const ink = readableInk(fill);
			const other = ink === '#ffffff' ? '#0b0e14' : '#ffffff';

			expect(contrast(ink, fill)).toBeGreaterThanOrEqual(contrast(other, fill));
		}
	});
});

describe('darkening a colour for a light background', () => {
	// 3:1 is WCAG 1.4.11 for non-text contrast — the right bar for a glyph, where 4.5:1 is the bar
	// for body text. The PHP original aimed at a luminance of 0.35 as a stand-in for this.
	it.each([
		['#ffffff'],
		['#ff0000'],
		['#53fc19'],
		['#00f2fe'],
		['#85c742'],
		['#1185fe'],
		['#feda75']
	])('%s ends up readable on white', (hex) => {
		expect(contrast(onLight(hex), '#ffffff')).toBeGreaterThanOrEqual(3);
	});

	it('leaves a colour that is already dark enough untouched', () => {
		// Twitch and Discord both clear 3:1 as they are, so darkening them would only make the
		// light theme disagree with the dark one for no reason.
		expect(onLight('#9146ff')).toBe('#9146ff');
		expect(onLight('#5865f2')).toBe('#5865f2');
	});

	it('keeps the hue rather than mixing toward grey', () => {
		// The reason this moves lightness in OKLCH instead of scaling sRGB channels: a darkened red
		// has to still be a red. Kick's green darkens to a green.
		const [r, g, b] = [1, 3, 5].map((at) => parseInt(onLight('#53fc19').slice(at, at + 2), 16));

		expect(g).toBeGreaterThan(r ?? 0);
		expect(g).toBeGreaterThan(b ?? 0);
	});

	it('terminates on the hardest input instead of running to the bound', () => {
		// White is the worst case: if the loop could fail to converge, it would be here.
		expect(onLight('#ffffff')).not.toBe('#0b0e14');
	});

	/**
	 * The text bar, for a colour that is read as a word rather than seen as a mark.
	 *
	 * A viewer's chat colour is the case this was added for: they picked it against a platform's
	 * dark chat, and on a light page their name still has to be legible. 3:1 is the threshold for
	 * an icon; a name is text.
	 */
	it.each([
		['#ffffff'],
		['#ff0000'],
		['#53fc19'],
		['#00f2fe'],
		['#feda75'],
		['#9146ff'],
		['#74b816']
	])('%s reaches the text bar when asked for it', (hex) => {
		expect(contrast(onLight(hex, TEXT_CONTRAST), '#ffffff')).toBeGreaterThanOrEqual(TEXT_CONTRAST);
	});

	it('darkens further for text than for a mark', () => {
		// Otherwise the parameter is decoration: a colour sitting between the two bars has to come
		// back different depending on which was asked for. Kick's green is exactly such a colour.
		const asMark = onLight('#53fc19', GLYPH_CONTRAST);
		const asText = onLight('#53fc19', TEXT_CONTRAST);

		expect(asText).not.toBe(asMark);
		expect(contrast(asText, '#ffffff')).toBeGreaterThan(contrast(asMark, '#ffffff'));
	});

	it('defaults to the mark bar, so every existing caller is unchanged', () => {
		expect(onLight('#53fc19')).toBe(onLight('#53fc19', GLYPH_CONTRAST));
	});
});

describe('the measurements themselves', () => {
	it('agrees with WCAG at both ends', () => {
		expect(luminance('#ffffff')).toBeCloseTo(1, 4);
		expect(luminance('#000000')).toBeCloseTo(0, 4);
		expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
	});

	it('holds text to 4.5 rather than 3', () => {
		// #767676 on white is 4.54 — the canonical "just passes" grey.
		expect(isReadableText('#767676', '#ffffff')).toBe(true);
		expect(isReadableText('#929292', '#ffffff')).toBe(false);
	});
});
