/**
 * The database schema.
 *
 * Five tables. Three arrived together because {@link sessions} is the first state in this project
 * that genuinely cannot live in a file: a session has to be revocable, and "sign out everywhere" is
 * a `DELETE ... WHERE user_id = ?` rather than a cookie somebody still holds.
 *
 * The rule this file keeps is that **a table arrives with the code that reads it** — here
 * `accounts.ts`, `session.ts` and `api-tokens.ts`. A table nobody reads is worse than no table, because it looks like
 * a feature that broke. What was here before was the scaffold's `task` table, which nothing imported
 * and every install would have created.
 *
 * ### Why not the config document
 *
 * The config *document* stays a file: it is the thing a creator edits, diffs and backs up, and a row
 * in SQLite is none of those. Users and sessions are the opposite — nobody hand-edits a session, and
 * a session table is queried by expiry and by user, which is what a database is for.
 *
 * ### What is still to come
 *
 * | stage | tables |
 * | --- | --- |
 * | 6 | calendar events |
 * | 8 | link-click metrics |
 * | — | the admin's audit trail, alongside whatever first writes to it |
 *
 * Stage 4 is done and added nothing here, which an earlier version of this comment expected it to.
 * Posts are cached to files by `src/lib/server/cache.ts`, because a cache entry lives for minutes,
 * is regenerated on demand, and should not persist in a form that outlives the code that wrote it.
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The roles a user may hold, widest first.
 *
 * Presets over a capability set rather than the capability set itself — a plugin will be able to
 * declare capabilities, and a role is what an admin actually assigns. `owner` is the installation's
 * own account, and is the one role the last holder of cannot give up.
 */
export const ROLES = ['owner', 'admin', 'editor', 'moderator', 'member'] as const;

/** One of {@link ROLES}. */
export type Role = (typeof ROLES)[number];

/** What a brand-new account gets. Deliberately the narrowest. */
export const DEFAULT_ROLE: Role = 'member';

/**
 * A person.
 *
 * Separate from {@link identities} because one person may sign in several ways, and the thing that
 * owns their role must not be their Discord account specifically.
 */
export const users = sqliteTable('users', {
	/** A UUID from the application, rather than an autoincrementing row id. */
	id: text('id').primaryKey(),

	/** What to call them on screen. Taken from the provider at first sign-in, editable after. */
	name: text('name').notNull(),

	/** An absolute `https` url, or null. Not copied or cached — it is somebody else's cdn. */
	avatarUrl: text('avatar_url'),

	/** One of {@link ROLES}, validated by the code that writes it rather than by a constraint. */
	role: text('role').notNull().$type<Role>(),

	/** Unix seconds. An integer rather than a text timestamp, so comparisons are numeric. */
	createdAt: integer('created_at')
		.notNull()
		.default(sql`(unixepoch())`)
});

/**
 * One way a user signs in.
 *
 * Keyed uniquely on `(provider, providerUserId)`, which is the constraint that makes a second
 * sign-in through the same provider find the existing user instead of creating another. Enforced by
 * the database rather than by a check-then-insert, because two sign-ins arriving together would
 * both pass the check.
 */
export const identities = sqliteTable(
	'identities',
	{
		/** `discord`, `google`, `twitch` — whichever provider this came from. */
		provider: text('provider').notNull(),

		/** The provider's own id for the person. Never an email, which people change. */
		providerUserId: text('provider_user_id').notNull(),

		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		createdAt: integer('created_at')
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [
		uniqueIndex('identities_provider_user').on(table.provider, table.providerUserId),
		index('identities_user').on(table.userId)
	]
);

/**
 * An active sign-in.
 *
 * ### The id is a hash, not the token
 *
 * The cookie holds a random token; this table holds its SHA-256. A database that leaks therefore
 * leaks nothing usable — an attacker holding every row still cannot build a cookie, because the hash
 * does not reverse. Looking a session up is hashing the cookie and selecting by primary key, which
 * is the same single-row lookup it would otherwise have been.
 *
 * ### Why rows rather than a signed cookie
 *
 * A signed cookie cannot be revoked. Signing out on a shared machine, or after a laptop is stolen,
 * has to invalidate the session rather than ask whoever holds it to stop presenting it.
 */
export const sessions = sqliteTable(
	'sessions',
	{
		/** SHA-256 of the cookie token, hex. See the note above. */
		id: text('id').primaryKey(),

		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		/** Unix seconds. A session past this is gone whether or not anything has swept it yet. */
		expiresAt: integer('expires_at').notNull(),

		/**
		 * When this session was last used, in unix seconds.
		 *
		 * Written on a sliding renewal rather than on every request: a write per page view would turn
		 * every read of the admin into a database write for no benefit anyone can observe.
		 */
		lastSeenAt: integer('last_seen_at')
			.notNull()
			.default(sql`(unixepoch())`),

		createdAt: integer('created_at')
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [
		// "Sign out everywhere" and "list my sessions" are both this lookup.
		index('sessions_user').on(table.userId),

		// Sweeping expired rows is a range scan over this.
		index('sessions_expires').on(table.expiresAt)
	]
);

/**
 * How an account was linked.
 *
 * OAuth wherever a platform offers it, because the secret never passes through a form. A pasted
 * token is the route for a platform with no OAuth for the capability, and the escape hatch when an
 * OAuth application cannot be registered. A direct login is the last resort, for a platform that
 * offers nothing else — declared per platform, never a default.
 */
export const LINK_METHODS = ['oauth', 'token', 'login'] as const;

/** One of {@link LINK_METHODS}. */
export type LinkMethod = (typeof LINK_METHODS)[number];

/**
 * A platform account somebody linked.
 *
 * ### One row, every purpose
 *
 * This is deliberately not "a credential for the post feed". It is an *account*, and what it can be
 * used for follows from its platform and the scopes the platform actually granted: the links page
 * reads it for a handle and a profile URL, the post reader reads it for a token, the live badge
 * reads it for a channel id. An environment variable could serve exactly one of those, which is why
 * adding a platform used to mean touching three places.
 *
 * ### Why not in {@link identities}
 *
 * A row that can sign you in and a row that holds somebody else's API token have different blast
 * radii. `identities` stays a bare pointer with no secret in it, so a leak of it is a list of public
 * account ids; this table holds credentials and is encrypted. Sharing one table would mean the
 * cheaper row carried the more expensive row's risk.
 *
 * ### The tokens are encrypted
 *
 * `accessToken` and `refreshToken` hold what `src/lib/server/secrets.ts` produced, never a raw
 * token. A SQLite file ends up in backups, snapshots and the copy somebody made before an upgrade,
 * and losing it should not be the same as losing every creator's platform access.
 */
export const connections = sqliteTable(
	'connections',
	{
		/** A UUID from the application. */
		id: text('id').primaryKey().notNull(),

		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		/** `twitch`, `youtube`, `kick`, `tiktok` — the platform's own id in this codebase. */
		platform: text('platform').notNull(),

		/** The platform's own id for the account. Never a handle, which its owner can change. */
		platformAccountId: text('platform_account_id').notNull(),

		/** What the account is called on that platform, for showing and for building a profile URL. */
		handle: text('handle'),

		/** A display name, where the platform has one separate from the handle. */
		displayName: text('display_name'),

		/** An absolute `https` avatar url, or null. Not copied — it is the platform's cdn. */
		avatarUrl: text('avatar_url'),

		/** One of {@link LINK_METHODS}, validated by the code that writes it. */
		method: text('method').notNull().$type<LinkMethod>(),

		/** Encrypted. Null for a link that carries no secret, such as a public-read-only platform. */
		accessToken: text('access_token'),

		/** Encrypted. Null where the platform issues no refresh token. */
		refreshToken: text('refresh_token'),

		/** Unix seconds the access token expires at, or null where it does not expire. */
		expiresAt: integer('expires_at'),

		/**
		 * The scopes the platform actually granted, space-separated.
		 *
		 * What was granted, not what was asked for. A capability check has to read this rather than
		 * assume the request succeeded in full, because a user can decline individual scopes on several
		 * of these platforms and the result is a link that works for less than it looks like.
		 */
		scopes: text('scopes').notNull().default(''),

		/** Whether this account is shown publicly as one of the creator's socials. */
		shown: integer('shown', { mode: 'boolean' }).notNull().default(false),

		createdAt: integer('created_at')
			.notNull()
			.default(sql`(unixepoch())`),

		/** When the stored credential was last replaced, in unix seconds. */
		updatedAt: integer('updated_at')
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [
		// One row per real-world account, for the same reason `identities` is unique: two rows for one
		// account are two credentials that can disagree about which is current.
		uniqueIndex('connections_platform_account').on(table.platform, table.platformAccountId),

		// "What has this person linked", which is the account page.
		index('connections_user').on(table.userId),

		// "What is linked for this platform", which is how a provider resolves its credential.
		index('connections_platform').on(table.platform)
	]
);

/**
 * What an API token is allowed to do, widest first.
 *
 * Two, not a scope vocabulary. The question a token answers is "may this change anything", and that
 * is the one distinction worth asking somebody to make when they create one: a backup script, a
 * monitoring check and a metrics dashboard all want `read`, and handing them `write` is the mistake
 * this exists to let people avoid. A finer vocabulary would have to name every endpoint, and a scope
 * list that drifts out of step with the routes is worse than none, because it reads like a guarantee.
 *
 * Ordered widest first to match {@link ROLES}, so the comparison is an index comparison in both
 * places rather than two different idioms.
 */
export const ABILITIES = ['write', 'read'] as const;

/** One of {@link ABILITIES}. */
export type Ability = (typeof ABILITIES)[number];

/** What a token gets when nobody chose. The narrowest, as with {@link DEFAULT_ROLE}. */
export const DEFAULT_ABILITY: Ability = 'read';

/**
 * An API token: a credential a person issues to a program acting for them.
 *
 * ### The id is a hash, exactly as in {@link sessions}
 *
 * The holder has a random token; this table has its SHA-256. So a lookup is hashing what arrived and
 * selecting by primary key, a leak of the whole table yields nothing presentable, and a row can be
 * listed and revoked by its own id without a page ever handling the credential.
 *
 * SHA-256 rather than a password hash, for the reason the session table gives: the secret is 256
 * bits from `randomBytes`, so there is no dictionary to make expensive and nothing to guess. A slow
 * hash here would only make every API request slow.
 *
 * ### `hint` is not a credential, and no role is stored
 *
 * `hint` is the first few characters of the token — enough to tell two rows apart in a list, far too
 * little to present. The token deliberately carries **no role of its own**: a request made with one
 * acts with the owner's *current* role, read from {@link users} at use time, so demoting somebody
 * takes effect on their tokens immediately instead of leaving a credential behind that still holds
 * the role they had when they made it.
 */
export const apiTokens = sqliteTable(
	'api_tokens',
	{
		/** SHA-256 of the token, hex. See the note above. */
		id: text('id').primaryKey(),

		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),

		/** What the person called it — "backup script", "uptime check". Theirs, shown back to them. */
		name: text('name').notNull(),

		/** The token's first few characters. Non-secret, and the only way to tell rows apart. */
		hint: text('hint').notNull(),

		/** One of {@link ABILITIES}, validated by the code that writes it. */
		ability: text('ability').notNull().$type<Ability>(),

		/**
		 * Unix seconds this token stops working at, or null for one that does not expire.
		 *
		 * Nullable rather than defaulted to some far-future date: "this never expires" is a decision
		 * somebody made and should read as one, and a sentinel year would eventually arrive.
		 */
		expiresAt: integer('expires_at'),

		/**
		 * When it was last presented, in unix seconds, or null for one never used.
		 *
		 * Null is the useful part. A token created, pasted wrong and forgotten looks exactly like a
		 * working one until this column distinguishes them, and "never used" is the most actionable
		 * thing a list of credentials can say.
		 */
		lastUsedAt: integer('last_used_at'),

		createdAt: integer('created_at')
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [
		// "My tokens", which is the account page, and the scope every mutation is constrained by.
		index('api_tokens_user').on(table.userId),

		// Sweeping expired rows is a range scan over this, as it is for sessions.
		index('api_tokens_expires').on(table.expiresAt)
	]
);
