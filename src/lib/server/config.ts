/**
 * The questions about configuration that are not a single variable.
 *
 * The variables themselves are declared in `src/env.ts` and read from `$app/env/private`, already
 * validated and typed — so this is deliberately small. It exists for the two things a declaration
 * cannot express: a predicate over several variables, and the rule that an integration with
 * incomplete credentials is *off* rather than half-working.
 *
 * Read a variable directly wherever one variable is the answer. Reaching through a wrapper for
 * `SYNCHRA_TOKEN` would only add a place for the two to disagree.
 */

import {
	ADMIN_DISCORD_IDS,
	DISCORD_CLIENT_ID,
	DISCORD_CLIENT_SECRET,
	SYNCHRA_CHANNEL_ID,
	SYNCHRA_TOKEN,
	TWITCH_CLIENT_ID,
	TWITCH_CLIENT_SECRET
} from '$app/env/private';

/**
 * Whether the public feeds — live status and chat — can run.
 *
 * These read endpoints Synchra serves without a token, so a channel id on its own is enough. This
 * is deliberately separate from {@link hasSynchraToken}: removing the token leaves live status and
 * chat working and only takes the token-only feeds offline. One predicate for both would have
 * turned a narrowed token into a blank page.
 */
export function hasSynchraChannel(): boolean {
	return SYNCHRA_CHANNEL_ID !== undefined;
}

/** Whether the token-only feeds — the support and donation activity — can run. */
export function hasSynchraToken(): boolean {
	return SYNCHRA_TOKEN !== undefined && SYNCHRA_CHANNEL_ID !== undefined;
}

/**
 * Whether Discord sign-in is configured.
 *
 * Both halves or neither: a client id without its secret cannot complete a token exchange, so an
 * admin page that checked only the id would offer a sign-in that fails at the last step.
 */
export function hasDiscordAuth(): boolean {
	return DISCORD_CLIENT_ID !== undefined && DISCORD_CLIENT_SECRET !== undefined;
}

/**
 * Whether anyone can actually get into the admin.
 *
 * Sign-in being configured is not the same as somebody being allowed through it. An empty
 * allow-list with working credentials is the state where every sign-in succeeds and every
 * authorisation fails, which looks like a bug and is really a missing setting.
 */
export function hasAdmin(): boolean {
	return hasDiscordAuth() && ADMIN_DISCORD_IDS.length > 0;
}

/** Whether the Twitch VOD and clip feed can run. As Discord above: both halves or neither. */
export function hasTwitchApi(): boolean {
	return TWITCH_CLIENT_ID !== undefined && TWITCH_CLIENT_SECRET !== undefined;
}

/** Whether a Discord id is allowed into the admin. */
export function isAdmin(discordId: string): boolean {
	return ADMIN_DISCORD_IDS.includes(discordId);
}

/**
 * Which integrations are usable, for the admin's status panel and the first-run setup.
 *
 * One place that answers "what is wired up", so a page does not assemble its own list and get it
 * subtly different from the next page's.
 */
export function integrationStatus(): Readonly<Record<string, boolean>> {
	return {
		synchraPublic: hasSynchraChannel(),
		synchraToken: hasSynchraToken(),
		discordAuth: hasDiscordAuth(),
		admin: hasAdmin(),
		twitchApi: hasTwitchApi()
	};
}
