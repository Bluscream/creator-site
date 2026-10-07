/**
 * Every icon the site draws, as data.
 *
 * Ported from `Icons.php`, which carried ~200 lines of hand-pasted SVG path data — the YouTube
 * silhouette, the Instagram outline, the X mark — and a `svg()` that assembled an element as a
 * string. **None of that path data survives here.** The brand marks come from `simple-icons`, which
 * is the upstream the paths were copied from in the first place, and the interface glyphs come from
 * `lucide`, the maintained successor to the Feather set the originals were traced from. A brand
 * refresh is now `npm update` rather than someone noticing.
 *
 * `svg()` does not port either, and should not: it existed because PHP has no component model. This
 * module is data, and a Svelte component renders it. Two consequences worth keeping:
 *
 * - `forBrowser()` is gone. It serialised this registry into `window.PLATFORMS` so the chat could
 *   draw a mark in the browser; the chat now imports this module, and the bundler tree-shakes it.
 * - The icons stay as *elements and attributes*, never markup. The chat builds every row with
 *   `createElementNS` and never `innerHTML`, because the same code renders text a viewer typed —
 *   so it cannot be handed markup, however safe this file's own markup would be. lucide's data
 *   shape is already exactly that.
 */

import {
	Calendar,
	CircleDot,
	Gift,
	Heart,
	Layers,
	Link,
	MessageCircle,
	RectangleGoggles,
	RefreshCw,
	ShoppingBag
} from 'lucide';
import {
	siBluesky,
	siDiscord,
	siInstagram,
	siKick,
	siRumble,
	siThreads,
	siTiktok,
	siTwitch,
	siVrchat,
	siX,
	siYoutube
} from 'simple-icons';

/**
 * One drawing instruction: a tag and its attributes.
 *
 * Structurally lucide's own `IconNode` element, redeclared because the package does not export the
 * type. Checked against it by assignment below, so a shape change upstream is a compile error here
 * rather than a surprise at render time.
 */
export type IconElement = readonly [
	tag: string,
	// `undefined` is part of lucide's own attribute type, so it has to be part of this one for the
	// assignment below to be a real check rather than a cast.
	attrs: Readonly<Record<string, string | number | undefined>>
];

/** An outline glyph: drawn with `fill="none" stroke="currentColor"`, on a 24 grid. */
export interface StrokeIcon {
	readonly kind: 'stroke';
	readonly elements: readonly IconElement[];
}

/**
 * A brand mark: one filled path, on a 24 grid, with the brand's official colour.
 *
 * `hex` is what the brand publishes, which is not always what this site draws it in — see the
 * overrides in `platforms.ts`. It is carried here so an override is visibly a decision.
 */
export interface BrandIcon {
	readonly kind: 'brand';
	readonly title: string;
	readonly path: string;
	readonly hex: string;
}

export type Icon = StrokeIcon | BrandIcon;

/** The icon drawn for a name nothing is registered under. */
export const FALLBACK_ICON = 'link';

function stroke(elements: readonly IconElement[]): StrokeIcon {
	return { kind: 'stroke', elements };
}

function brand(icon: { title: string; path: string; hex: string }): BrandIcon {
	return { kind: 'brand', title: icon.title, path: icon.path, hex: `#${icon.hex.toLowerCase()}` };
}

/**
 * Every icon, keyed by the name configuration refers to it by.
 *
 * The keys are the PHP registry's keys, so imported configuration keeps working. Two notes where a
 * key and its drawing no longer agree with the original:
 *
 * - **`link`** drew Feather's *info* circle in the PHP version, despite being the fallback for an
 *   unknown icon name. It now draws an actual link glyph, which is what the name promises and what
 *   a reader of a mislabelled button is better served by.
 * - **`platform-ring`** was a hand-drawn ring with an `evenodd` hole, used for Kick, Rumble,
 *   Bluesky and Owncast because the site had no mark for them. Three of those four now have their
 *   real mark from `simple-icons`, so the ring is left only for Owncast.
 */
export const ICONS: Readonly<Record<string, Icon>> = {
	// Interface glyphs.
	link: stroke(Link),
	chat: stroke(MessageCircle),
	layers: stroke(Layers),
	calendar: stroke(Calendar),
	gift: stroke(Gift),
	heart: stroke(Heart),
	'shopping-bag': stroke(ShoppingBag),
	vr: stroke(RectangleGoggles),

	/** Two arcs chasing each other, which is what the hand-drawn Synchra glyph was. */
	synchra: stroke(RefreshCw),

	/** For a platform with no mark of its own published anywhere — Owncast. */
	'platform-ring': stroke(CircleDot),

	// Brand marks, official paths and official colours.
	youtube: brand(siYoutube),
	twitch: brand(siTwitch),
	tiktok: brand(siTiktok),
	instagram: brand(siInstagram),
	threads: brand(siThreads),
	'twitter-x': brand(siX),
	discord: brand(siDiscord),
	vrchat: brand(siVrchat),
	kick: brand(siKick),
	rumble: brand(siRumble),
	bluesky: brand(siBluesky)
};

/** Every icon name, for the admin's picker. The picker and the renderer read the same list. */
export function iconNames(): readonly string[] {
	return Object.keys(ICONS);
}

export function hasIcon(name: string): boolean {
	return name in ICONS;
}

/**
 * One icon by name, falling back rather than returning nothing.
 *
 * Configuration is hand-edited, and a typo in an icon name should cost a wrong glyph rather than a
 * button with a hole in it.
 */
export function icon(name: string): Icon {
	return ICONS[name] ?? ICONS[FALLBACK_ICON] ?? stroke(Link);
}
