/**
 * What a provider is, and what it can be asked.
 *
 * This project is a product other people install, and most of them will not have an account with
 * whichever service this developer happens to use. So every capability that reaches a visitor is
 * defined here as an interface, and the service behind it is a deployment's choice:
 *
 * | capability | implementations that exist or are planned |
 * | --- | --- |
 * | `live` | Synchra · Restream · Twitch Helix · YouTube Data · Kick · Owncast |
 * | `chat` | Synchra · Restream · Twitch EventSub · YouTube live chat |
 * | `activity` | Synchra · StreamElements · Streamlabs · Ko-fi · Patreon · Fourthwall |
 * | `events` | Synchra gateway · Twitch EventSub · a webhook receiver |
 *
 * ### One interface per capability, not one per provider
 *
 * Owncast can answer "am I live" and nothing else. Twitch can do live and chat but knows nothing
 * about donations. Ko-fi knows only about donations. A single `Provider` interface would force all
 * of them to stub out most of it, and would make "does this deployment have chat" unanswerable
 * without trying it. A provider implements the interfaces it can and declares which in its
 * {@link ProviderDescriptor}.
 *
 * ### A provider never touches HTTP or configuration
 *
 * It receives its credentials, returns this project's own domain types, and throws
 * {@link ServiceFailure} when it cannot. It does not read the environment, does not know what a
 * `Response` is, and does not decide status codes — so a provider contributed later, by someone
 * else, cannot get any of that subtly wrong.
 */

import type { Activity } from '#lib/activity.js';
import type { Chat } from '#lib/chat.js';
import type { SiteEvent } from '#lib/events.js';
import type { LiveStatus } from '#lib/live.js';
import type { Credential } from '#lib/server/providers/credentials.js';

/** The things a provider can do. */
export const CAPABILITIES = ['live', 'chat', 'activity', 'events'] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** What a provider says about itself, for the registry and the admin's status panel. */
export interface ProviderDescriptor {
	/** Stable identifier, used in configuration and as the credential key. Lower kebab case. */
	readonly id: string;
	/** What to call it in the admin. */
	readonly name: string;
	/** Which interfaces this provider implements. */
	readonly capabilities: readonly Capability[];
	/** Where an operator goes to get credentials, shown in the setup flow. */
	readonly setupUrl?: string;
}

/** Live state across the creator's platforms. */
export interface LiveProvider {
	readonly descriptor: ProviderDescriptor;
	liveStatus(): Promise<LiveStatus>;
}

/**
 * Recent chat, oldest first.
 *
 * `limit` is the caller's, not the provider's: how much chat a page wants is a product decision,
 * and a provider that hard-coded it would make the overlay and the popup disagree. A provider that
 * cannot honour the exact number returns what it can rather than failing.
 *
 * Returning a {@link Chat} with `available: false` rather than throwing is deliberate — being
 * refused this one feed is a normal state for a deployment whose token was granted narrowly, and
 * the rest of the page is unaffected. A provider still throws `ServiceFailure` for an actual
 * failure, which is a different thing and is reported differently.
 */
export interface ChatProvider {
	readonly descriptor: ProviderDescriptor;
	chat(limit: number): Promise<Chat>;
}

/** Recent support events — donations, subs, gifts — newest first. */
export interface ActivityProvider {
	readonly descriptor: ProviderDescriptor;
	activity(limit: number): Promise<Activity>;
}

/**
 * A push connection, for the services that have one.
 *
 * The separate capability is the point: `chat` is "give me the last forty messages" and `events` is
 * "tell me when one arrives". A provider can have either without the other — Owncast can be polled
 * and pushes nothing; a webhook-only donation service pushes and cannot be asked for a backlog —
 * and the page works with any combination, because a deployment with no event provider polls the
 * endpoints exactly as it did before this existed.
 *
 * `start` is handed a sink rather than returning a stream so the provider does not have to care how
 * many browsers are attached, or whether any are. It returns the function that closes the
 * connection, which is the only thing the caller can usefully do with it.
 */
export interface EventProvider {
	readonly descriptor: ProviderDescriptor;
	start(publish: (event: SiteEvent) => void): Promise<() => void>;
}

/**
 * A provider that is built from credentials and can say whether it has enough of them.
 *
 * `usable` is separate from construction so the registry can ask the question without doing the
 * work, and so the admin can list a provider as "available but not configured" rather than hiding
 * it. It must not make a network call — "are the credentials present and well-formed", not "do
 * they work".
 */
export interface ProviderFactory<T> {
	readonly descriptor: ProviderDescriptor;
	usable(credential: Credential): boolean;
	create(credential: Credential): T;
}
