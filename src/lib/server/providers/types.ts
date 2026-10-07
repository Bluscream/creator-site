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

import type { LiveStatus } from '#lib/live.js';
import type { Credential } from '#lib/server/providers/credentials.js';

/** The things a provider can do. */
export const CAPABILITIES = ['live', 'chat', 'activity'] as const;

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
