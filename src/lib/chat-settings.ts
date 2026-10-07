/**
 * The chat page's display settings, read from the query string.
 *
 * Ported from the `$flag`/`$number`/`$choice` helpers in `main/chat/index.php`. The PHP read each
 * setting from the query string, then from the chat's own `config.json`, then from a stated
 * default. **The middle step is not ported yet**: those defaults are admin-editable, so they belong
 * with the admin and the database (stage 5). Until then a query parameter or the default applies,
 * which is exactly how an OBS browser source is configured anyway — the URL *is* the configuration.
 *
 * ### Why every value is forced into a known shape here
 *
 * A query parameter is the least trustworthy input on the page: it is whatever was in a link
 * somebody clicked. Each one is clamped, matched against a closed list, or reduced to a boolean at
 * the point it is read, so nothing downstream has to ask whether `size` might be `-1` or `1e9`, and
 * no value reaches the page as markup.
 */

/** A truthy query flag. Anything that is not one of these is off — the PHP's rule, kept. */
const TRUE_WORDS = ['1', 'true', 'yes', 'on'];

/**
 * Just enough of `URLSearchParams` to read one.
 *
 * SvelteKit's `page.url.searchParams` is a `ReadonlyURLSearchParams`, which is deliberately *not*
 * a `URLSearchParams` — it has no `set` or `append`. Asking for the narrow thing this actually
 * needs accepts both, and says in the signature that nothing here mutates the query.
 */
export interface QueryParams {
	get(name: string): string | null;
}

/** How the log is ordered on screen. */
export const ORDERS = ['oldest', 'newest'] as const;

export type Order = (typeof ORDERS)[number];

/** What is painted behind the log. `transparent` is what an OBS browser source wants. */
export const BACKGROUNDS = ['page', 'solid', 'transparent'] as const;

export type Background = (typeof BACKGROUNDS)[number];

export interface ChatSettings {
	/** Messages kept on screen, 5–200. */
	readonly limit: number;
	/** Whether support events are merged into the log. */
	readonly events: boolean;
	readonly avatars: boolean;
	readonly badges: boolean;
	/** The little platform mark on each row. */
	readonly platform: boolean;
	readonly background: Background;
	/** Font size in pixels, 10–48. */
	readonly fontSize: number;
	/** Drop a message after this many seconds. 0 keeps them. */
	readonly fadeAfter: number;
	readonly order: Order;
}

export const CHAT_DEFAULTS: ChatSettings = {
	limit: 60,
	events: true,
	avatars: true,
	badges: true,
	platform: true,
	background: 'page',
	fontSize: 15,
	fadeAfter: 0,
	order: 'oldest'
};

function flag(params: QueryParams, name: string, fallback: boolean): boolean {
	const raw = params.get(name);

	if (raw === null || raw === '') return fallback;

	return TRUE_WORDS.includes(raw.toLowerCase());
}

function number(
	params: QueryParams,
	name: string,
	fallback: number,
	min: number,
	max: number
): number {
	const raw = params.get(name);

	// `/^\d+$/` rather than `Number()`: the latter accepts `1e9`, ` 12 `, `0x10` and `Infinity`, and
	// clamping those is a worse answer than ignoring them.
	if (raw === null || !/^\d+$/.test(raw)) return fallback;

	return Math.max(min, Math.min(max, Number(raw)));
}

function choice<T extends string>(
	params: QueryParams,
	name: string,
	fallback: T,
	allowed: readonly T[]
): T {
	const raw = params.get(name);

	return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * The settings for one visit.
 *
 * The parameter names are the PHP page's, so every OBS source URL already written against it keeps
 * working: `bg`, `size`, `fade` rather than `background`, `fontSize`, `fadeAfter`.
 */
export function chatSettings(params: QueryParams): ChatSettings {
	return {
		limit: number(params, 'limit', CHAT_DEFAULTS.limit, 5, 200),
		events: flag(params, 'events', CHAT_DEFAULTS.events),
		avatars: flag(params, 'avatars', CHAT_DEFAULTS.avatars),
		badges: flag(params, 'badges', CHAT_DEFAULTS.badges),
		platform: flag(params, 'platform', CHAT_DEFAULTS.platform),
		background: choice(params, 'bg', CHAT_DEFAULTS.background, BACKGROUNDS),
		fontSize: number(params, 'size', CHAT_DEFAULTS.fontSize, 10, 48),
		fadeAfter: number(params, 'fade', CHAT_DEFAULTS.fadeAfter, 0, 3600),
		order: choice(params, 'order', CHAT_DEFAULTS.order, ORDERS)
	};
}
