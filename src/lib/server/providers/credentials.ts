/**
 * The one place a provider's credentials come from.
 *
 * Every provider is handed a {@link Credential} and reads nothing itself. That is the point: with
 * credentials fetched wherever a client happens to be constructed, adding a second provider means
 * adding a second way to configure one, and the admin ends up unable to answer "what is set up".
 *
 * ### Why one shape for all of them
 *
 * A token, an OAuth client pair, a channel id and a base URL cover every provider in the table in
 * `types.ts`, and a union per provider would push the discrimination into each one. A provider
 * declares what it needs by what its `usable()` checks, which is also what the setup flow reads to
 * know which fields to ask for.
 *
 * ### Today the environment, tomorrow the database
 *
 * Secrets for *this* deployment are environment variables, because that is where a self-hosted
 * secret belongs and because the admin does not exist yet. Once it does, a creator will paste a
 * Twitch client secret into a form and it will be stored encrypted — and only this module changes.
 * Nothing downstream knows where a credential came from.
 */

import {
	SYNCHRA_CHANNEL_ID,
	SYNCHRA_TOKEN,
	TWITCH_CLIENT_ID,
	TWITCH_CLIENT_SECRET
} from '$app/env/private';

/**
 * Everything a provider might need to authenticate and to know whose data to fetch.
 *
 * Every field optional, because which ones matter is the provider's business. A provider that needs
 * one it did not get reports itself unusable rather than throwing at the first request.
 */
export interface Credential {
	/** A personal access token or API key. */
	readonly token?: string;
	/** An OAuth application's id, for a client-credentials or user grant. */
	readonly clientId?: string;
	readonly clientSecret?: string;
	/** Whose data to read — a channel id, a user id, a Restream account. */
	readonly channelId?: string;
	/** For a self-hosted provider: where it lives, e.g. an Owncast instance. */
	readonly baseUrl?: string;
}

/**
 * The credentials configured for a provider, by its descriptor id.
 *
 * An unknown id returns an empty credential rather than throwing, so a configuration naming a
 * provider that is not installed degrades to "not configured" instead of taking the page down.
 */
export function credentialsFor(providerId: string): Credential {
	switch (providerId) {
		case 'synchra':
			return withoutUndefined({
				token: SYNCHRA_TOKEN,
				channelId: SYNCHRA_CHANNEL_ID
			});

		case 'twitch':
			return withoutUndefined({
				clientId: TWITCH_CLIENT_ID,
				clientSecret: TWITCH_CLIENT_SECRET
			});

		default:
			return {};
	}
}

/**
 * Drops absent fields instead of carrying them as explicit `undefined`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined", and a provider
 * writing `'token' in credential` should get the answer an operator would expect.
 */
function withoutUndefined(credential: Record<string, string | undefined>): Credential {
	return Object.fromEntries(Object.entries(credential).filter(([, value]) => value !== undefined));
}
