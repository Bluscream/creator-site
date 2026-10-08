/**
 * How long a new API token may be asked to live.
 *
 * Its own module because a `+page.server.ts` may only export what SvelteKit recognises — `load`,
 * `actions` and a short list of options — so anything the page and the server both need lives
 * beside them. The same reason `../backup/policy.ts` exists.
 */

/**
 * The offered lifetimes, in seconds, shortest first.
 *
 * A fixed set rather than a number field. A free number is a field somebody types `30` into meaning
 * days while the server reads seconds, and both failures are silent: a credential that expires in
 * half a minute, and one that outlives the installation.
 *
 * `null` is offered because the honest answer for a deployment's own backup script is "until I
 * remove it", and a product that forces a date gets tokens with a date nobody tracks. It is last,
 * so the list reads from safest to longest-lived.
 */
export const LIFETIMES = {
	'30d': 30 * 24 * 60 * 60,
	'90d': 90 * 24 * 60 * 60,
	'1y': 365 * 24 * 60 * 60,
	never: null
} as const;

/** One of the keys of {@link LIFETIMES}. */
export type LifetimeChoice = keyof typeof LIFETIMES;

/** The choices, for the page to render. */
export const LIFETIME_CHOICES = Object.keys(LIFETIMES) as readonly LifetimeChoice[];

/**
 * A lifetime choice, as seconds or null.
 *
 * Anything unrecognised becomes the **shortest** offered rather than `never`: a field that did not
 * arrive, or arrived from something that is not this page, must not be the route by which a
 * permanent credential gets made.
 */
export function lifetimeOf(value: string | null): number | null {
	if (value !== null && value in LIFETIMES) return LIFETIMES[value as LifetimeChoice];

	return LIFETIMES['30d'];
}
