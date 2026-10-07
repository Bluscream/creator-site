/**
 * The registry of platforms the site knows about.
 *
 * Ported from `Platforms.php` and `Platform.php`. What the original carried and this does not:
 *
 * - **brand colours** now come from `simple-icons` with the mark, so YouTube's red is not written
 *   out here at all. Only a *deliberate disagreement* with the official colour is recorded, and it
 *   has to say why.
 * - **the colour maths** — WCAG luminance, the darken loop — moved to `color.ts`, which is culori.
 * - **`forBrowser()`** is gone: it serialised this registry for `window.PLATFORMS` so the chat
 *   could draw a mark client-side. The chat imports this module instead.
 *
 * What remains is the part no library can know: which platform a URL belongs to, what this site
 * calls it, and where the official colour is the wrong colour for a dark page.
 */

import { onLight, readableInk } from '#lib/color.js';
import { hasIcon, icon } from '#lib/icons.js';

/**
 * A platform's recorded facts, before the defaults are applied.
 *
 * `icon` defaults to the key, so only a platform whose icon is named differently — `twitter`
 * drawing `twitter-x` — says so. `short` defaults to the name, rather than being abbreviated for
 * the sake of it.
 */
interface PlatformSpec {
	readonly name: string;
	readonly short?: string;
	readonly hosts: readonly string[];
	readonly icon?: string;
	/** Overrides the official brand colour. Requires a reason in a comment. */
	readonly primary?: string;
	readonly secondary?: string;
	/** The brand colour as *text* on a dark background, when the fill colour will not read as one. */
	readonly tint?: string;
	/** The same on a light background. Defaults to {@link onLight} of the primary. */
	readonly tintLight?: string;
}

/**
 * Every known platform.
 *
 * Ordered as they are registered, which is the order the admin's picker shows.
 */
const SPECS: Readonly<Record<string, PlatformSpec>> = {
	youtube: {
		name: 'YouTube',
		short: 'YT',
		secondary: '#0f0f0f',
		tint: '#ff4d4d',
		hosts: ['youtube.com', 'youtu.be', 'm.youtube.com']
	},
	twitch: {
		name: 'Twitch',
		secondary: '#772ce8',
		// Twitch's #9146ff against a near-black panel reads as a smudge rather than a word.
		tint: '#a970ff',
		hosts: ['twitch.tv', 'twitch.com']
	},
	tiktok: {
		name: 'TikTok',
		// TikTok's official colour is black, which is no colour at all on a dark page. Its palette
		// is black with a cyan and a red offset, and the cyan is the one that reads as TikTok.
		primary: '#00f2fe',
		secondary: '#fe2c55',
		tint: '#35e4ef',
		hosts: ['tiktok.com', 'vm.tiktok.com']
	},
	instagram: {
		name: 'Instagram',
		short: 'IG',
		// The mark is a gradient; a flat fill has to pick one end of it, and simple-icons publishes
		// the pink. The orange is the other end, for anything drawing the gradient itself.
		secondary: '#f77737',
		hosts: ['instagram.com', 'instagr.am']
	},
	twitter: {
		// X's mark is black on white and white on black. Official is black, so the *fill* here is
		// inverted for the dark surfaces this site draws on — and `tintLight` is left to default,
		// which lands back on near-black: the brand's own light-mode mark.
		name: 'Twitter / X',
		short: 'X',
		primary: '#ffffff',
		secondary: '#000000',
		icon: 'twitter-x',
		hosts: ['x.com', 'twitter.com', 't.co']
	},
	threads: {
		// As X above: black on light surfaces, white on dark ones.
		name: 'Threads',
		primary: '#ffffff',
		secondary: '#000000',
		hosts: ['threads.net', 'threads.com']
	},
	discord: {
		name: 'Discord',
		secondary: '#404eed',
		hosts: ['discord.com', 'discord.gg', 'discordapp.com']
	},
	vrchat: {
		// VRChat publishes black; its own blue is what the site has always drawn, with the dark grey
		// it pairs the wordmark with as the secondary.
		name: 'VRChat',
		primary: '#156ccd',
		secondary: '#313131',
		hosts: ['vrchat.com', 'vrc.group']
	},
	synchra: {
		// Not in simple-icons, so both the mark and the colours are this site's own. The violet end
		// of Synchra's gradient is far too dark to read as a word on a dark panel, hence the tint
		// from Synchra's own stylesheet. It reads fine on a light theme, so no tintLight.
		name: 'Synchra',
		primary: '#2f024f',
		secondary: '#00062c',
		tint: '#9679b5',
		hosts: ['synchra.net', 'dash.synchra.net']
	},
	// The rest of what Synchra can deliver a chat message from. Here so a message from one is
	// labelled rather than showing a raw `kick`, and so the chat has one list to ask.
	kick: { name: 'Kick', hosts: ['kick.com'] },
	rumble: { name: 'Rumble', hosts: ['rumble.com'] },
	bluesky: { name: 'Bluesky', hosts: ['bsky.app', 'bsky.social', 'blueskyweb.xyz'] },
	owncast: {
		// No published mark anywhere, so it keeps the ring. All three colours are from Owncast's own
		// stylesheet: its primary, the blue it pairs with it, and the lighter violet it uses for a
		// link on a dark page — which is exactly what a tint is.
		name: 'Owncast',
		primary: '#6544e9',
		secondary: '#2386e2',
		tint: '#7a5cf3',
		icon: 'platform-ring',
		hosts: ['owncast.online']
	}
};

/** One platform, with everything the site might want to draw it with. */
export interface Platform {
	readonly key: string;
	readonly name: string;
	/** A compact label for somewhere a full name will not fit. */
	readonly short: string;
	/** The brand colour to fill with, or null for a platform with none recorded anywhere. */
	readonly primary: string | null;
	readonly secondary: string | null;
	/** The icon name, resolvable through {@link icon}. */
	readonly icon: string;
	readonly hosts: readonly string[];
	/** The brand colour as readable text on a dark surface. */
	readonly tint: string | null;
	/** The same on a light one. */
	readonly tintLight: string | null;
	/** Black or white, whichever stays readable on {@link primary}. Null without a primary. */
	readonly ink: string | null;
}

function build(key: string, spec: PlatformSpec): Platform {
	const iconName = spec.icon ?? (hasIcon(key) ? key : 'platform-ring');
	const drawn = icon(iconName);
	const official = drawn.kind === 'brand' ? drawn.hex : null;
	const primary = spec.primary ?? official;

	return {
		key,
		name: spec.name,
		short: spec.short ?? spec.name,
		primary,
		secondary: spec.secondary ?? null,
		icon: iconName,
		hosts: spec.hosts,
		tint: spec.tint ?? primary,
		// The light-theme ink falls back to a *darkened* brand colour rather than the colour itself:
		// a white brand would otherwise publish white as the colour to draw its mark in on a pale
		// panel, which is no mark at all.
		tintLight: spec.tintLight ?? (primary === null ? null : onLight(primary)),
		ink: primary === null ? null : readableInk(primary)
	};
}

const PLATFORMS: Readonly<Record<string, Platform>> = Object.fromEntries(
	Object.entries(SPECS).map(([key, spec]) => [key, build(key, spec)])
);

export function hasPlatform(key: string): boolean {
	return key in PLATFORMS;
}

/** One platform by key, or null when nothing is registered under it. */
export function platform(key: string | null | undefined): Platform | null {
	return key === null || key === undefined ? null : (PLATFORMS[key] ?? null);
}

/** Every platform, in the order they are registered. */
export function platforms(): readonly Platform[] {
	return Object.values(PLATFORMS);
}

/** Every platform as key → display name, for the admin's picker. */
export function platformLabels(): Readonly<Record<string, string>> {
	return Object.fromEntries(platforms().map((entry) => [entry.key, entry.name]));
}

/**
 * The platform a URL belongs to, by host.
 *
 * Matches the host itself and any subdomain of it, so `m.twitch.tv` resolves without being listed —
 * but as a suffix on a dot boundary, so `nottwitch.tv` does not. `www.` is dropped first because it
 * is noise on every host it appears on.
 */
export function detectPlatform(url: string): Platform | null {
	let host: string;

	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		// Not a URL at all. A caller passing configuration gets null rather than an exception.
		return null;
	}

	if (host === '') return null;

	for (const entry of platforms()) {
		for (const candidate of entry.hosts) {
			if (host === candidate || host.endsWith(`.${candidate}`)) return entry;
		}
	}

	return null;
}

/**
 * One link as configuration records it, before anything is resolved.
 *
 * Every field is `| undefined` as well as optional, which `exactOptionalPropertyTypes` otherwise
 * treats as different things. It matters because these entries come from a parsed configuration
 * document, where an absent field is present-and-undefined rather than missing — so without it,
 * every caller would have to build an entry by conditionally assigning each key.
 */
export interface LinkEntry {
	readonly id?: string | undefined;
	readonly url?: string | undefined;
	readonly name?: string | undefined;
	readonly icon?: string | undefined;
	readonly color?: string | undefined;
	readonly platform?: string | undefined;
}

/**
 * The platform behind one configured link, or null when it is not a platform link at all.
 *
 * Three steps in this order, which is what lets most entries say nothing at all:
 *
 * 1. an explicit `platform` on the entry — the escape hatch, and the only thing that works for a
 *    URL that gives nothing away;
 * 2. the URL's host, so `https://youtube.com/@someone` needs no annotation;
 * 3. the entry's `id`, which for a social button is already the platform name.
 *
 * Step 2 fails for a vanity redirect like `yt.example.com`, whose host says only `example.com`.
 * That is exactly the case steps 1 and 3 exist for.
 */
export function platformFor(entry: LinkEntry): Platform | null {
	if (entry.platform !== undefined && hasPlatform(entry.platform)) {
		return platform(entry.platform);
	}

	if (entry.url !== undefined) {
		const detected = detectPlatform(entry.url);

		if (detected !== null) return detected;
	}

	return platform(entry.id);
}

/**
 * The icon to draw for an entry: its own, else its platform's, else the fallback.
 *
 * The entry still wins, because an entry is allowed to be a platform link that wants a different
 * glyph — a watch page listed with the chat icon, because what it offers the reader is a chat.
 */
export function iconFor(entry: LinkEntry, fallback = 'link'): string {
	if (entry.icon !== undefined && entry.icon !== '' && hasIcon(entry.icon)) return entry.icon;

	return platformFor(entry)?.icon ?? fallback;
}

/** The display name for an entry: its own, else its platform's, else the fallback. */
export function nameFor(entry: LinkEntry, fallback = ''): string {
	if (entry.name !== undefined && entry.name !== '') return entry.name;

	return platformFor(entry)?.name ?? fallback;
}

/**
 * The per-platform custom properties, one rule per platform, for the page to inline.
 *
 * ```css
 * [data-platform="twitch"]{--platform:#9146ff;--platform-ink:#a970ff;--platform-ink-light:#7c3aed}
 * ```
 *
 * Emitted rather than written into a stylesheet because the colours were otherwise repeated at
 * every place they are used — a toast's border, a chat row's label, and the light-theme reading of
 * each — and every repetition was a place a colour could change in the registry without changing on
 * the page. A platform with no colour recorded emits nothing, so those fall through to the ordinary
 * ink rather than to a colour nobody chose.
 */
export function platformCss(): string {
	return platforms()
		.filter((entry) => entry.primary !== null)
		.map(
			(entry) =>
				`[data-platform="${entry.key}"]{--platform:${entry.primary ?? ''};` +
				`--platform-ink:${entry.tint ?? entry.primary ?? ''};` +
				`--platform-ink-light:${entry.tintLight ?? entry.primary ?? ''}}`
		)
		.join('');
}
