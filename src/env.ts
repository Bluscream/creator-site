/**
 * Every environment variable this application reads, declared once.
 *
 * This is the port of `Config.php`, and almost all of that class is gone rather than translated.
 * It hand-wrote `.env` parsing — read the file, skip comments, split on the first `=`, trim quotes
 * — plus a `getenv()` fallback and a manual readability check. SvelteKit does the loading, and the
 * `schema` field takes a Standard Schema validator, which zod implements. So a variable is now
 * *declared*: validated when the app starts, typed where it is used, and documented on hover.
 *
 * Two properties of the original kept deliberately:
 *
 * - **An absent integration is a supported state, not a fatal one.** Nearly everything here is
 *   optional. The site renders without a Synchra token; the endpoints that need one report
 *   themselves unavailable rather than failing. `.optional()` is load-bearing, not laziness.
 * - **Nothing is public.** `public` defaults to false, so every value below is server-only and
 *   `$app/env/private` is a module the bundler refuses to ship to a browser. A credential cannot
 *   reach the client by someone importing the wrong thing.
 *
 * What is deliberately *not* here: anything the creator edits in the admin. The PHP class mixed
 * credentials with settings — avatar lookup URL templates and the regexes that scrape them — and
 * those belong in the database with the rest of the configuration, not in a file only a shell can
 * reach. Secrets and deployment facts live here; settings do not.
 */

import { defineEnvVars } from '@sveltejs/kit/env';
import { z } from 'zod';

/**
 * One `ADMIN_ACCOUNTS` entry: a provider kind, a colon, and the provider's own id for somebody.
 *
 * The id half is deliberately loose about its shape — a Discord snowflake is digits, a Google
 * subject is digits, a GitHub id is digits, but nothing says the next provider's is. What is
 * enforced is that there is a provider, there is an id, and neither contains anything that would
 * make one entry match another.
 */
const adminAccount = /^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9_.-]{1,128}$/;

/**
 * `ADMIN_ACCOUNTS` as a list, from the comma-separated string an operator sets.
 *
 * Exported and pure so it can be tested directly. It decides who can always get into the admin, and
 * every way it could go wrong is silent: an entry matched case-sensitively, or kept despite being
 * malformed, reads to the person who set it as "the environment says I am an admin and the site
 * disagrees".
 *
 * Lower-cased on both sides of the comparison, because a provider kind is lower case by convention
 * and an operator who typed `Discord:123` meant the same thing. Anything that is not `provider:id`
 * is dropped rather than kept as a value some comparison might accidentally match.
 */
export function parseAdminAccounts(raw: string | undefined): readonly string[] {
	return (raw ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => adminAccount.test(entry));
}

/**
 * `ALLOW_REGISTRATION`, as a boolean.
 *
 * Only `true` and `1` turn it on. Anything else — including `yes`, `on` and an empty value left
 * behind by commenting out the line badly — leaves it off, because the safe reading of an unclear
 * setting is the one that does not open registration.
 */
export function parseAllowRegistration(raw: string | undefined): boolean {
	return raw === 'true' || raw === '1';
}

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'The database connection string.',
		schema: z.string().min(1)
	},

	/**
	 * Where the database, the log and the cache live.
	 *
	 * Also read directly from `process.env` by `src/lib/server/log.ts`, which must not import this
	 * module: the logger is what reports a configuration failure, so a logger that read
	 * configuration would recurse at the moment the site is least able to cope. Declared here
	 * anyway, so it is validated at startup and documented in one place.
	 */
	DATA_DIR: {
		description: 'Directory for the database, logs and cache. Never web-reachable. Default: data',
		schema: z.string().min(1).optional()
	},

	LOG_LEVEL: {
		description: 'pino level: trace, debug, info, warn, error, fatal. Default: info',
		schema: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional()
	},

	// --- Synchra -------------------------------------------------------------------------------

	/**
	 * The Synchra token.
	 *
	 * Absent is supported: the site still renders and the endpoints that need Synchra report
	 * themselves unavailable instead of failing.
	 */
	SYNCHRA_TOKEN: {
		description: 'Synchra API token. Optional; token-only feeds go offline without it.',
		schema: z.string().min(1).optional()
	},

	SYNCHRA_CHANNEL_ID: {
		description: 'The Synchra channel whose live state, chat and activity the site shows.',
		schema: z.string().min(1).optional()
	},

	SYNCHRA_WATCH_URL: {
		description: 'The watch page embedded by the chat and live pages.',
		schema: z.url().optional()
	},

	// --- Discord, for signing in to the admin --------------------------------------------------

	DISCORD_CLIENT_ID: {
		description: 'Discord application id. Without it the admin refuses to run.',
		schema: z.string().min(1).optional()
	},

	DISCORD_CLIENT_SECRET: {
		description: 'Discord application secret.',
		schema: z.string().min(1).optional()
	},

	/**
	 * The OAuth2 redirect, when it must be pinned rather than derived.
	 *
	 * Normally built from the request, because the site answers on several hostnames and each needs
	 * its own registered redirect. Set this to override.
	 */
	DISCORD_REDIRECT_URI: {
		description: 'Pins the OAuth2 redirect instead of deriving it from the request.',
		schema: z.url().optional()
	},

	// --- The key everything else is stored behind ------------------------------------------------

	/**
	 * The key that linked accounts' tokens are encrypted with.
	 *
	 * The one credential that stays an environment variable, because something has to be: a key stored
	 * next to what it encrypts is decoration. Everything else — a creator's Twitch token, their
	 * YouTube refresh token — moves into the database behind this.
	 *
	 * Any passphrase of 16 characters or more. It is stretched with scrypt rather than used raw, so it
	 * does not have to be exactly 32 bytes of correctly generated base64; `openssl rand -base64 32` is
	 * still the easiest way to produce one.
	 *
	 * **Changing it makes every linked account unreadable** and they have to be linked again. Without
	 * it, linking is refused rather than storing a token in the clear.
	 */
	SECRET_KEY: {
		description:
			"Passphrase that linked accounts' tokens are encrypted with. Keep it and back it up.",
		schema: z.string().min(16).optional()
	},

	// --- Who administers this installation -----------------------------------------------------

	/**
	 * The accounts that administer this installation, as `provider:id` pairs.
	 *
	 * `discord:123456789012345678,google:11822…` — the provider's own id, never a username, because a
	 * username can be changed by its owner and then registered by somebody else. Not Discord-specific:
	 * this product is not bound to one vendor, and the sign-in providers are a seam.
	 *
	 * An account named here is an `admin` as soon as it exists, and is raised back to `admin` if it
	 * ended up lower — the escape hatch that makes the rest of the role system safe to use, because a
	 * creator can always get back into their own site. It does not *lower* anybody: an owner named
	 * here stays the owner.
	 *
	 * **Set this before exposing a fresh install to the internet.** The first account to sign in to an
	 * unclaimed install becomes the owner; this is what makes that survivable.
	 *
	 * An entry that is not `provider:id` is dropped rather than kept as something a comparison might
	 * accidentally match, and an empty list means nobody is named.
	 */
	ADMIN_ACCOUNTS: {
		description: 'Comma-separated `provider:id` accounts that administer this install.',
		schema: z.string().optional().transform(parseAdminAccounts)
	},

	/**
	 * Whether somebody nobody has seen before may create an account.
	 *
	 * Off by default. Turning it on hands the creator a moderation queue, deletion requests and abuse
	 * reports, and that should be a decision rather than something that happened. Signing in to an
	 * account that already exists is unaffected, and so is claiming an install that has none.
	 */
	ALLOW_REGISTRATION: {
		description: 'Set to `true` to let new visitors create accounts. Off by default.',
		schema: z.string().optional().transform(parseAllowRegistration)
	},

	// --- Twitch, for the post feed -------------------------------------------------------------

	/**
	 * The Twitch application the post feed reads VODs and clips through.
	 *
	 * These two are all the client-credentials grant needs — no user sign-in, no redirect, no
	 * refresh token — which is what makes Twitch the one platform here with a real API behind it
	 * rather than a scraped feed.
	 */
	TWITCH_CLIENT_ID: {
		description: 'Twitch application id, for the VOD and clip feed.',
		schema: z.string().min(1).optional()
	},

	TWITCH_CLIENT_SECRET: {
		description: 'Twitch application secret.',
		schema: z.string().min(1).optional()
	},

	/**
	 * The Kick application an account is linked through.
	 *
	 * Unlike Twitch's, these are not a feed credential: Kick is OAuth-only on the account page, and
	 * the token that comes back belongs to the creator rather than to the application. Kick requires
	 * PKCE, which `auth/oauth2.ts` handles.
	 */
	KICK_CLIENT_ID: {
		description: 'Kick application id, for linking a Kick account.',
		schema: z.string().min(1).optional()
	},

	KICK_CLIENT_SECRET: {
		description: 'Kick application secret.',
		schema: z.string().min(1).optional()
	},

	/**
	 * The Google application a YouTube channel is linked through.
	 *
	 * Named for YouTube rather than Google because that is the platform: the OAuth is Google's, but
	 * the identity stored is a YouTube channel id, and this is not a way of signing in.
	 */
	YOUTUBE_CLIENT_ID: {
		description: 'Google application id, for linking a YouTube channel.',
		schema: z.string().min(1).optional()
	},

	YOUTUBE_CLIENT_SECRET: {
		description: 'Google application secret.',
		schema: z.string().min(1).optional()
	}
});
