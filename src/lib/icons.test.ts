/**
 * The icon registry.
 *
 * Nothing here checks what a glyph looks like — that is the upstream packages' business, and
 * checking path data by hand would be copying it back in. What it checks is the contract between
 * the registry and the component that draws it, and the two properties the registry promises: an
 * unknown name falls back rather than returning nothing, and every brand mark carries a real
 * colour.
 */

import { describe, expect, it } from 'vitest';
import { isHexColor } from '#lib/color.js';
import {
	DRAWABLE_TAGS,
	FALLBACK_ICON,
	ICONS,
	hasIcon,
	icon,
	iconNames,
	isDrawableTag,
	undrawableTags
} from '#lib/icons.js';

describe('looking an icon up', () => {
	it.each(iconNames())('%s resolves to itself', (name) => {
		expect(icon(name)).toBe(ICONS[name]);
	});

	it('falls back for a name nothing is registered under', () => {
		// Configuration is hand-edited, and a typo should cost a wrong glyph rather than a button
		// with a hole in it.
		expect(icon('definitely-not-an-icon')).toBe(ICONS[FALLBACK_ICON]);
	});

	it('has the fallback it names', () => {
		// Otherwise the fallback path falls back again, to a glyph nobody chose.
		expect(hasIcon(FALLBACK_ICON)).toBe(true);
	});

	it('agrees with itself about what it has', () => {
		for (const name of iconNames()) expect(hasIcon(name)).toBe(true);

		expect(hasIcon('definitely-not-an-icon')).toBe(false);
	});

	it('registers something at all', () => {
		// So an empty registry — an import that resolved to nothing — cannot pass every other case
		// in this file by having no cases to run.
		expect(iconNames().length).toBeGreaterThan(10);
	});
});

describe('brand marks', () => {
	const brands = Object.entries(ICONS).filter(([, drawing]) => drawing.kind === 'brand');

	it('exist', () => {
		expect(brands.length).toBeGreaterThan(0);
	});

	it.each(brands)('%s carries a usable hex colour, a path and a title', (_name, drawing) => {
		// The official colour is what `platforms.ts` derives a platform's tint from, so a blank or
		// malformed one would propagate into a colour calculation rather than failing visibly.
		if (drawing.kind !== 'brand') throw new Error('filtered to brands');

		expect(isHexColor(drawing.hex)).toBe(true);
		expect(drawing.path.length).toBeGreaterThan(0);
		expect(drawing.title.length).toBeGreaterThan(0);
	});
});

/**
 * Every primitive the registry uses must be one the component can draw.
 *
 * This is the invariant that keeps `Icon.svelte`'s compile-time tag list honest. The component
 * cannot build an element from a string, so a tag it has no branch for renders as *nothing* —
 * silently, and indistinguishably from a missing icon. `npm update lucide` is the realistic way
 * that happens: a glyph gets redrawn upstream using a primitive nothing here used before.
 */
describe('what the icon component can draw', () => {
	it('has a branch for every tag the registry uses', () => {
		expect(undrawableTags()).toEqual([]);
	});

	it('agrees with itself about which tags those are', () => {
		// Guards the other direction: a tag dropped from DRAWABLE_TAGS while the component kept its
		// branch would leave the check above passing for the wrong reason.
		for (const tag of DRAWABLE_TAGS) expect(isDrawableTag(tag)).toBe(true);

		expect(isDrawableTag('foreignObject')).toBe(false);
	});

	it('draws stroke glyphs out of primitives at all', () => {
		// Catches a registry whose stroke icons all lost their elements — every tag would then be
		// drawable because there would be none, and the check above would pass vacuously.
		const used = new Set<string>();

		for (const drawing of Object.values(ICONS)) {
			if (drawing.kind !== 'stroke') continue;

			for (const [tag] of drawing.elements) used.add(tag);
		}

		expect(used.size).toBeGreaterThan(0);
	});
});
