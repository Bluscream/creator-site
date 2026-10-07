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

/** A Discord snowflake: 17–20 digits. */
const snowflake = /^\d{17,20}$/;

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

	/**
	 * Discord user ids allowed into the admin.
	 *
	 * Ids rather than names: a Discord username can be changed by its owner and reused by somebody
	 * else, while a snowflake is permanent. Anything that is not a snowflake is dropped rather than
	 * kept as an entry some string comparison might accidentally match — and an empty list means
	 * nobody gets in, which is the right failure for a missing setting.
	 */
	ADMIN_DISCORD_IDS: {
		description: 'Comma-separated Discord user ids allowed into the admin. Empty means nobody.',
		schema: z
			.string()
			.optional()
			.transform((raw) =>
				(raw ?? '')
					.split(',')
					.map((id) => id.trim())
					.filter((id) => snowflake.test(id))
			)
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
	}
});
