/**
 * API tokens: the credential a person issues to a program acting for them.
 *
 * Deliberately the same shape as `session.ts` — a random token, its SHA-256 as the row's primary
 * key, a lookup that is one indexed read, and revocation by row id. The two files are close enough
 * that the obvious move would be to share the mechanism, and they are not merged because what they
 * mean differs in every direction that matters: a session is created by signing in and expires by
 * default, a token is created on purpose and expires only if asked; a session is renewed on use, a
 * token never is; a session has no abilities because a browser is a person, and a token has one
 * because a program is not. A shared implementation would be a function with two of every parameter.
 *
 * ### What a token is, and is not
 *
 * It **acts as its owner, with the owner's current role**. There is no role on the row, so demoting
 * somebody takes effect on their tokens at once rather than leaving behind a credential that still
 * carries what they used to be. It is not a service account: an install that wants one makes a user
 * and gives that user a token, which keeps "whose action was this" answerable.
 *
 * The one thing it adds beyond its owner's role is a *restriction*: {@link Ability} `read` cannot
 * change anything, so the common cases — a backup script, an uptime check, a dashboard — can hold a
 * credential that is useless to whoever finds it in a CI log.
 *
 * ### The prefix is for everyone else's benefit
 *
 * Tokens read `crs_…`. A fixed prefix is what makes a leaked credential **findable**: secret
 * scanners, `gitleaks`, and the project's own `secretlint` pre-commit hook all work by recognising
 * shapes, and an unprefixed base64 blob is indistinguishable from a hash. It also means somebody
 * who finds one in an environment file can tell what it opens. The cost is four characters.
 *
 * ### Why there is no way to read a token back
 *
 * {@link create} and {@link rotate} return the token once. Nothing stores it, so nothing can show it
 * again, and the page says so at the point somebody is deciding whether to copy it. A product that
 * can re-display a credential is a product whose database holds one.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import { ABILITIES, apiTokens, users } from './db/schema.js';
import { db } from './db/index.js';
import { roleOf } from './accounts.js';
import type { Ability } from './db/schema.js';
import type { Principal } from './session.js';

/**
 * What every token starts with.
 *
 * `crs` for creator-site. Underscore rather than a hyphen so the whole token is one word to a
 * double-click and to every "select the token" regex anybody writes.
 */
export const TOKEN_PREFIX = 'crs_';

/** 32 bytes — 256 bits — base64url, as with a session token. Past guessing. */
const TOKEN_BYTES = 32;

/**
 * How much of a token the list shows.
 *
 * Enough to tell two rows apart at a glance, which is the whole job: six base64url characters of a
 * 43-character secret, leaving the 37 that matter unshown. Shown *with* the prefix, so what is on
 * screen is a true leading substring of what somebody pasted into their script and they are
 * comparing like with like.
 */
const HINT_CHARS = 6;

/** The longest name worth storing. A label for a list, not a description. */
export const MAX_NAME = 60;

/**
 * How many live tokens one person may hold.
 *
 * A limit rather than none, because every row here is a credential and an unbounded list is a thing
 * nobody audits. Generous enough that nobody legitimate meets it; low enough that a loop in somebody
 * else's automation is refused instead of filling a table.
 */
export const MAX_PER_USER = 50;

/**
 * How stale `lastUsedAt` is allowed to get, in seconds.
 *
 * An hour. Writing it on every request would turn a read-only API into one database write per call,
 * for a column whose only readers are a human looking at a list. What this must *not* blur is the
 * difference between "used an hour ago" and **"never used"**, which is the actionable state — so a
 * token with no `lastUsedAt` is always written on first use, regardless of this.
 */
const USED_RESOLUTION = 60 * 60;

/** Unix seconds, as every timestamp in the schema is. */
function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * The lookup key for a token.
 *
 * SHA-256, for the reason `session.ts` gives at more length: the secret is 256 random bits, so there
 * is no dictionary to make expensive, and a slow hash would only add latency to every API request.
 */
function keyFor(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Whether a string could be one of ours at all, before any database is touched. */
export function looksLikeToken(value: string): boolean {
	return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length;
}

/**
 * The token out of an `Authorization` header, or null.
 *
 * Here rather than in `hooks.server.ts` because it is part of how a token is *presented*, and
 * because a parser buried in a hook is a parser with no test.
 *
 * Case-insensitive on the scheme: RFC 7235 says it is, and lowercase `bearer` is what several HTTP
 * clients send. Anything that is not a bearer scheme — `Basic`, or a bare token with no scheme —
 * returns null rather than being guessed at, which is also what keeps the cookie working behind
 * infrastructure that adds an `Authorization` header of its own.
 */
export function tokenFromHeader(header: string | null): string | null {
	if (header === null) return null;

	const [scheme, ...rest] = header.split(' ');

	if (scheme?.toLowerCase() !== 'bearer') return null;

	const value = rest.join(' ').trim();

	return value === '' ? null : value;
}

/**
 * Whether an ability covers what is needed.
 *
 * {@link ABILITIES} is widest first, so this is an index comparison — the same shape as `atLeast`
 * for roles, so that the two checks in one guard read alike. An unrecognised ability is treated as
 * insufficient rather than as the widest.
 */
export function permits(held: Ability, needed: Ability): boolean {
	const have = ABILITIES.indexOf(held);
	const want = ABILITIES.indexOf(needed);

	return have !== -1 && want !== -1 && have <= want;
}

/** A string from a form, as an ability, defaulting to the narrowest. */
export function abilityOf(value: string | null | undefined): Ability {
	return ABILITIES.find((ability) => ability === value) ?? 'read';
}

/** Why a token could not be created. */
export type TokenProblem = 'no_name' | 'too_many';

/** A token, the once. */
export interface IssuedToken {
	/** The row id — the token's hash. Safe to show and to submit back; not a credential. */
	readonly id: string;

	/** **The only time this exists.** Not stored, and not recoverable from the row. */
	readonly token: string;
}

/** A token as resolved from what a client presented. */
export interface ResolvedToken {
	readonly principal: Principal;

	/** The row id, for logging which credential acted without logging the credential. */
	readonly id: string;

	/** What this token may do, which is a ceiling on top of the principal's role. */
	readonly ability: Ability;
}

/**
 * Issues a token for a user.
 *
 * @param lifetime seconds until it expires, or null for one that does not. Null is offered because
 *                 the honest answer for a deployment's own backup script is "until I remove it", and
 *                 a product that forces a date gets tokens with a date nobody tracks.
 * @returns the token, once, or why not
 */
export function create(
	userId: string,
	options: {
		readonly name: string;
		readonly ability: Ability;
		readonly lifetime: number | null;
	}
): IssuedToken | TokenProblem {
	const name = options.name.trim().slice(0, MAX_NAME);

	if (name === '') return 'no_name';

	// Counted live rather than from the whole table: an expired row is not a credential anybody
	// holds, so it should not be what stops somebody making a working one.
	if (listOf(userId).length >= MAX_PER_USER) return 'too_many';

	const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
	const id = keyFor(token);

	db()
		.insert(apiTokens)
		.values({
			id,
			userId,
			name,
			hint: token.slice(0, TOKEN_PREFIX.length + HINT_CHARS),
			ability: options.ability,
			expiresAt: options.lifetime === null ? null : now() + options.lifetime,

			// Written from the application clock rather than left to the column's `unixepoch()`
			// default, so that the creation time and the expiry are measured against the *same*
			// clock. They would otherwise differ by however far SQLite's idea of now has drifted
			// from the process's — a hair in production, and the whole test suite under fake timers,
			// where `rotate` could appear to be older than the row it replaced.
			createdAt: now(),

			// Explicitly null rather than left to the column default, so the "never used" state is
			// written by this function rather than inherited.
			lastUsedAt: null
		})
		.run();

	return { id, token };
}

/**
 * Who a token belongs to, or null.
 *
 * Null for a token that does not exist, one that has expired, and one whose user is gone — the same
 * three cases `session.resolve` collapses, for the same reason: a client can act on none of them
 * differently, and telling them apart would be telling an attacker which of their guesses was a real
 * token that had lapsed.
 *
 * An expired row is deleted on the way past, which costs one write on a request already being
 * refused and keeps an abandoned install from accumulating rows nothing sweeps.
 */
export function resolve(token: string): ResolvedToken | null {
	// Checked before hashing so that an `Authorization` header holding something else entirely —
	// a Discord token, a basic-auth blob — costs no database read.
	if (!looksLikeToken(token)) return null;

	const id = keyFor(token);

	const [found] = db()
		.select({
			expiresAt: apiTokens.expiresAt,
			lastUsedAt: apiTokens.lastUsedAt,
			ability: apiTokens.ability,
			userId: users.id,
			name: users.name,
			avatarUrl: users.avatarUrl,
			role: users.role
		})
		.from(apiTokens)
		// Inner join, so a token whose user was deleted resolves to nothing rather than to a
		// principal with no name. The cascade should have removed it; this does not rely on that.
		.innerJoin(users, eq(users.id, apiTokens.userId))
		.where(eq(apiTokens.id, id))
		.all();

	if (found === undefined) return null;

	const at = now();

	if (found.expiresAt !== null && found.expiresAt <= at) {
		db().delete(apiTokens).where(eq(apiTokens.id, id)).run();

		return null;
	}

	touch(id, found.lastUsedAt, at);

	return {
		id,
		// Validated rather than trusted: the column is a typed string, not a constraint, and an
		// unrecognised value becoming `read` is the direction to fail in.
		ability: abilityOf(found.ability),
		principal: {
			userId: found.userId,
			name: found.name,
			avatarUrl: found.avatarUrl,
			// Read from `users` on every request, which is what makes a demotion immediate.
			role: roleOf(found.role)
		}
	};
}

/**
 * Records that a token was used, if that is worth a write.
 *
 * Always on first use, because "never used" is the state somebody acts on. Afterwards at most once
 * per {@link USED_RESOLUTION}.
 */
function touch(id: string, lastUsedAt: number | null, at: number): void {
	if (lastUsedAt !== null && at - lastUsedAt < USED_RESOLUTION) return;

	db().update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id)).run();
}

/** One token, as a list shows it. Structurally incapable of carrying the credential. */
export interface TokenSummary {
	/** The row id — the token's hash. Safe to render and to accept back in a form. */
	readonly id: string;
	readonly name: string;

	/** The token's first characters, so two rows can be told apart. */
	readonly hint: string;
	readonly ability: Ability;
	readonly createdAt: number;

	/** Unix seconds, or null for a token that does not expire. */
	readonly expiresAt: number | null;

	/** Unix seconds, or null for one never presented. */
	readonly lastUsedAt: number | null;
}

/**
 * Every live token a user holds, newest first.
 *
 * Expired rows are filtered rather than deleted: this is a read, and a list that quietly wrote would
 * surprise the next person who added a caller. {@link sweep} is where deletion lives.
 */
export function listOf(userId: string): readonly TokenSummary[] {
	const at = now();

	return (
		db()
			.select({
				id: apiTokens.id,
				name: apiTokens.name,
				hint: apiTokens.hint,
				ability: apiTokens.ability,
				createdAt: apiTokens.createdAt,
				expiresAt: apiTokens.expiresAt,
				lastUsedAt: apiTokens.lastUsedAt
			})
			.from(apiTokens)
			.where(eq(apiTokens.userId, userId))
			// Tied on the id, which is arbitrary but stable. Two tokens created in the same second have
			// no real order, and the choice is between an arbitrary order that is the same every time
			// and one that may differ per query — which would make a list of credentials appear to
			// reshuffle itself on reload.
			.orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
			.all()
			.filter((row) => row.expiresAt === null || row.expiresAt > at)
			.map((row) => ({ ...row, ability: abilityOf(row.ability) }))
	);
}

/**
 * Replaces a token's secret, keeping everything else.
 *
 * **The expiry is kept, not extended.** Rotating is "this secret may have leaked, give me another",
 * not "give me another year" — and a rotation that silently pushed the expiry out would make a
 * deliberately short-lived token immortal by maintenance. Somebody who wants a longer life removes
 * it and creates one.
 *
 * Delete and insert in one transaction, because the row is keyed by the hash of the secret and a new
 * secret is therefore a new key. Either the old token stops working and the new one starts, or
 * neither happens; there is no window where both work and none where the owner holds nothing.
 *
 * @returns the new token, once, or null if that id is not this user's
 */
export function rotate(userId: string, id: string): IssuedToken | null {
	return db().transaction((tx) => {
		const [found] = tx
			.select({
				name: apiTokens.name,
				ability: apiTokens.ability,
				expiresAt: apiTokens.expiresAt,
				createdAt: apiTokens.createdAt
			})
			.from(apiTokens)
			// Scoped to the owner in the query rather than checked against a field: the id arrives
			// from outside the trust boundary whatever the page believes it rendered.
			.where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
			.all();

		if (found === undefined) return null;

		tx.delete(apiTokens).where(eq(apiTokens.id, id)).run();

		const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
		const next = keyFor(token);

		tx.insert(apiTokens)
			.values({
				id: next,
				userId,
				name: found.name,
				hint: token.slice(0, TOKEN_PREFIX.length + HINT_CHARS),
				ability: abilityOf(found.ability),
				expiresAt: found.expiresAt,
				// The grant is as old as it was; only the secret is new. A rotation that reset this
				// would erase the one number that says how long this credential has existed.
				createdAt: found.createdAt,
				lastUsedAt: null
			})
			.run();

		return { id: next, token };
	});
}

/**
 * Removes one token, by its row id.
 *
 * Scoped to the user, so an id belonging to somebody else is not found rather than deleted.
 *
 * @returns whether a token was removed
 */
export function revoke(userId: string, id: string): boolean {
	return (
		db()
			.delete(apiTokens)
			.where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
			.run().changes > 0
	);
}

/**
 * Removes every token a user holds.
 *
 * The counterpart to "sign out everywhere", and the thing to reach for when a laptop is lost: a
 * session cookie and a token on the same machine are two credentials, and ending one is half a job.
 *
 * @returns how many were removed
 */
export function revokeAll(userId: string): number {
	return db().delete(apiTokens).where(eq(apiTokens.userId, userId)).run().changes;
}

/**
 * Deletes expired tokens.
 *
 * Housekeeping, not correctness — {@link resolve} refuses an expired token and deletes it as it goes
 * — so this is for rows nobody ever presents again.
 *
 * The predicate is the same `expires_at < now` the session sweep uses, and it is the whole reason
 * this doc exists: `expires_at` is nullable here, and in SQL a comparison against NULL is NULL
 * rather than true, so a non-expiring token is left alone by arithmetic rather than by a condition
 * anybody wrote. That is correct and it is not obvious, which is why there is a test for it.
 */
export function sweep(): number {
	return db().delete(apiTokens).where(lt(apiTokens.expiresAt, now())).run().changes;
}
