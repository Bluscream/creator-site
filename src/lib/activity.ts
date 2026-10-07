/**
 * What a support event is to this application.
 *
 * A donation, a sub, a gifted sub, a TikTok gift: the things a client turns into a toast. These are
 * this project's types, not a vendor's — the list of services that can report them is long
 * (Synchra, StreamElements, Streamlabs, Ko-fi, Patreon, Fourthwall) and the page must not be able
 * to tell which one answered.
 *
 * The client remembers which ids it has already shown, which is why this stays a plain list rather
 * than growing a cursor: it only ever has to cover the last few seconds.
 */

import type { MessageSegment } from '#lib/chat.js';

/** One support event. */
export interface ActivityEntry {
	readonly id: string;
	readonly provider: string;
	/** The specific event, e.g. `tiktok_gift`, `sub_gift`, `kofi_donation`. */
	readonly type: string;
	/** The same thing as the platform words it, for display. */
	readonly type_label: string;
	/**
	 * The broad category: `donation`, `subscription`, `subscription_gift`, `virtual_currency`, …
	 *
	 * Null when the provider does not classify the event. A client groups and filters on this rather
	 * than on {@link type}, of which there are several dozen.
	 */
	readonly group: string | null;
	readonly viewer: string;
	readonly avatar: string | null;
	/**
	 * How much, already scaled out of minor units.
	 *
	 * Providers report money as an integer plus a decimal place — 500 with two places is 5.00 — so
	 * the scaling happens once, here, rather than in every client that shows a number.
	 */
	readonly amount: number;
	/** ISO 4217 code for a money amount, or null when the count is not money. */
	readonly currency: string | null;
	/** What is being counted when it is not money: `diamond`, `month`, `bit`, … */
	readonly count_name: string;
	/** The viewer's attached message as plain text. Empty when they sent none. */
	readonly message: string;
	/** The same message resolved into drawable pieces, so a toast can show its emotes. */
	readonly message_parts: readonly MessageSegment[];
	/** The provider's own phrasing of the event, e.g. "X sent Heart Me". */
	readonly system_message: string;
	/**
	 * The colour to tint the toast with.
	 *
	 * Not necessarily a hex colour — a provider may send a CSS gradient, and TikTok does. Passed
	 * through as given, so a client must treat it as an arbitrary CSS colour value rather than
	 * parsing it.
	 */
	readonly colour: string | null;
	/** ISO 8601 at second precision with an explicit zero offset. */
	readonly created_at: string;
}

/**
 * Recent support activity.
 *
 * `available: false` for the same reason as chat: reading the activity feed is a per-channel grant,
 * and the rest of the page works without it.
 */
export interface Activity {
	readonly available: boolean;
	readonly reason: string | null;
	readonly activities: readonly ActivityEntry[];
}

/** Activity plus the cache's account of itself, which is what the endpoint returns. */
export interface ActivityResult extends Activity {
	readonly age: number;
	readonly stale: boolean;
}

/** The empty result, for when nothing has ever been fetched successfully. */
export const NO_ACTIVITY: Activity = {
	available: false,
	reason: null,
	activities: []
};
