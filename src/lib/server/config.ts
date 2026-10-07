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
	ADMIN_ACCOUNTS,
	ALLOW_REGISTRATION,
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
 * Sign-in being configured is enough: the first account on an install with none becomes the owner,
 * so a creator with working credentials and an empty `ADMIN_ACCOUNTS` can still claim their own
 * site. That is a deliberate difference from the PHP original, which had no accounts and so had to
 * treat an empty allow-list as "nobody".
 *
 * {@link hasNamedAdmins} is the question that list answers, and the two are reported separately
 * because they mean different things to the person setting the site up.
 */
export function hasAdmin(): boolean {
	return hasDiscordAuth();
}

/**
 * Whether anybody is named in `ADMIN_ACCOUNTS`.
 *
 * Not a gate — it is what lets the setup page say "nobody is named as an administrator, so whoever
 * signs in first owns this site". An install reachable from the internet should have this set before
 * it is announced.
 */
export function hasNamedAdmins(): boolean {
	return ADMIN_ACCOUNTS.length > 0;
}

/** Whether a visitor nobody has seen before may create an account. */
export function allowsRegistration(): boolean {
	return ALLOW_REGISTRATION;
}

/** Whether the Twitch VOD and clip feed can run. As Discord above: both halves or neither. */
export function hasTwitchApi(): boolean {
	return TWITCH_CLIENT_ID !== undefined && TWITCH_CLIENT_SECRET !== undefined;
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
		namedAdmins: hasNamedAdmins(),
		registration: allowsRegistration(),
		twitchApi: hasTwitchApi()
	};
}
