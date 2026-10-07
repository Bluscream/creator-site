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
 * ### A linked account first, the environment second
 *
 * A credential now comes from a {@link Connection} — an account somebody linked on their account
 * page, stored encrypted — and falls back to an environment variable when nothing is linked for that
 * platform. In that order, deliberately:
 *
 * - **A linked account wins** because it is the newer, narrower and re-authorisable one. Somebody who
 *   has just linked their Twitch account and still has a stale `TWITCH_CLIENT_ID` in their `.env`
 *   means the link, not the file they forgot about.
 * - **The environment still works** because an existing deployment must not break on upgrade. It is
 *   the migration path, not a second way to configure the same thing — and once a platform is linked
 *   the variable is dead weight that can be removed.
 *
 * Nothing downstream knows which it got. That is the point of this module: a provider is handed a
 * {@link Credential} and asks no questions about where it came from, so moving a platform from the
 * environment into the database changes nothing but these few lines.
 */

import {
	SYNCHRA_CHANNEL_ID,
	SYNCHRA_TOKEN,
	TWITCH_CLIENT_ID,
	TWITCH_CLIENT_SECRET
} from '$app/env/private';
import { credentialFor } from '#lib/server/connections.js';

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
 * A linked account first, the environment second; see the note at the top. An unknown id returns an
 * empty credential rather than throwing, so a configuration naming a provider that is not installed
 * degrades to "not configured" instead of taking the page down.
 */
export function credentialsFor(providerId: string): Credential {
	const linked = fromConnection(providerId);

	if (linked !== null) return linked;

	return fromEnvironment(providerId);
}

/**
 * The credential from a linked account, or null when nothing is linked for that platform.
 *
 * The provider id and the platform id are the same string on purpose: a provider called `twitch`
 * reads the account linked as `twitch`. A mapping table between the two would be a second place for
 * them to disagree, and the only reason to want one is a provider serving two platforms — which does
 * not exist and would be a different seam if it did.
 *
 * Null rather than an empty credential, so {@link credentialsFor} can tell "nothing linked" from
 * "linked but carries no secret" and fall through only for the first.
 */
function fromConnection(providerId: string): Credential | null {
	const credential = credentialFor(providerId);

	if (credential === null) return null;

	return withoutUndefined({
		// The access token is what every one of these platforms authenticates a read with. A client id
		// and secret stay environment variables where they exist, because they identify the
		// *application* rather than the account — a different thing with a different lifetime.
		token: credential.accessToken ?? undefined,
		channelId: credential.platformAccountId,
		...applicationOf(providerId)
	});
}

/**
 * The application credentials for a platform, which are not part of a linked account.
 *
 * A client id and secret identify this installation's OAuth application; an access token identifies
 * the person who linked. Twitch needs both — its client-credentials grant and its user grant both
 * want the client id on every Helix call — so a linked Twitch account is merged with them rather
 * than replacing them.
 */
function applicationOf(providerId: string): Record<string, string | undefined> {
	return providerId === 'twitch'
		? { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET }
		: {};
}

/**
 * The credential from environment variables.
 *
 * The migration path for a deployment that predates linked accounts, and the only route for
 * `synchra`, which is the owner's own service and has no OAuth to link against.
 */
function fromEnvironment(providerId: string): Credential {
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
