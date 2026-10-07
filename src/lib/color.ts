/**
 * The two colour questions a brand palette keeps asking, answered by culori.
 *
 * Ported from `Platform::readableInk()` / `Platform::onLight()`, which hand-wrote sRGB relative
 * luminance and darkened a colour by scaling its channels by 0.85 in a bounded loop. culori does
 * the first properly and makes the second better than it was: scaling sRGB channels drifts the hue,
 * and the loop was aiming at a *luminance threshold* chosen as a proxy for a contrast ratio. Here
 * the ratio is the actual condition, and the lightness moves in OKLCH, which is perceptually even
 * and leaves the hue alone.
 */

import { converter, formatHex, parse, wcagContrast, wcagLuminance } from 'culori';

/** The ink used wherever this site needs "almost black" — the dark theme's own background colour. */
const DARK_INK = '#0b0e14';
const LIGHT_INK = '#ffffff';

/**
 * The page background a light-theme mark has to hold up against.
 *
 * White rather than the theme's actual panel colour, deliberately: it is the worst case, so a mark
 * that clears the ratio here clears it on every lighter-than-white surface too.
 */
const LIGHT_SURFACE = '#ffffff';

/**
 * What a *glyph* has to reach against its background.
 *
 * 3:1, which is WCAG 1.4.11 for non-text contrast — the right bar for an icon or a border, where
 * 4.5:1 is the bar for body text. The PHP original aimed at a luminance of 0.35 as a stand-in for
 * this; stating the ratio means the intent survives.
 */
const GLYPH_CONTRAST = 3;

/** Text on a filled surface is text, so it gets the text bar rather than the glyph one. */
const TEXT_CONTRAST = 4.5;

const toOklch = converter('oklch');

/** Is this a `#rrggbb` literal? The only colour syntax anything here writes out. */
export function isHexColor(value: unknown): value is string {
	return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Black or white, whichever stays readable on the given fill.
 *
 * This is why nothing hard-codes a label colour: Twitch's purple needs white on it and X's white
 * needs black, and either as a constant makes the other invisible. Picks whichever of the two inks
 * contrasts better, rather than thresholding luminance, so the answer is the one that actually
 * reads when neither is comfortable.
 */
export function readableInk(fill: string): string {
	return wcagContrast(fill, LIGHT_INK) >= wcagContrast(fill, DARK_INK) ? LIGHT_INK : DARK_INK;
}

/**
 * The given colour, darkened until it reads as a glyph on a near-white panel.
 *
 * The light theme's counterpart to a brand colour. Without it a white brand draws white-on-white
 * and the mark simply is not there, which is the same failure {@link readableInk} prevents in the
 * other direction.
 *
 * A colour that already clears the ratio is returned untouched, so Twitch's purple and Discord's
 * blurple are unaffected. The step count is bounded because a loop with no bound in a render path
 * is a loop that one day hangs a page over a rounding error.
 */
export function onLight(hex: string): string {
	const base = toOklch(hex);

	if (base === undefined) return DARK_INK;
	if (wcagContrast(hex, LIGHT_SURFACE) >= GLYPH_CONTRAST) return formatHex(base);

	for (let step = 1; step <= 50; step += 1) {
		const candidate = formatHex({ ...base, l: Math.max(0, base.l - step * 0.02) });

		if (wcagContrast(candidate, LIGHT_SURFACE) >= GLYPH_CONTRAST) return candidate;
	}

	// Pure black clears 21:1, so this is unreachable in practice; returning the darkest thing we
	// tried beats returning something that does not contrast at all.
	return DARK_INK;
}

/**
 * Whether text in `ink` is readable on `fill`, by the text bar rather than the glyph one.
 *
 * Not used by the registry — exposed because the themes installable from a URL will need to be
 * checked, and that check should not be a second opinion about what "readable" means.
 */
export function isReadableText(ink: string, fill: string): boolean {
	return wcagContrast(ink, fill) >= TEXT_CONTRAST;
}

/** The contrast ratio between two colours, 1–21. Re-exported so callers need not reach for culori. */
export function contrast(a: string, b: string): number {
	return wcagContrast(a, b);
}

/** sRGB relative luminance, 0–1. */
export function luminance(color: string): number {
	return wcagLuminance(color);
}

/** Whether a colour string is one culori can read at all. */
export function isColor(value: string): boolean {
	return parse(value) !== undefined;
}
