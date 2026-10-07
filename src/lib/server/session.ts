/**
 * Sessions: issuing one, resolving one, and revoking them.
 *
 * The cookie carries a random token and nothing else — no user id, no role, no expiry, nothing
 * signed. Everything about a session is a row, which is what makes it revocable. A token is only
 * ever a lookup key.
 *
 * ### The token is never stored
 *
 * `issue()` returns the token to put in a cookie and stores its SHA-256 as the row's primary key.
 * So the database holds no usable credential: an attacker with every row cannot construct a cookie,
 * because the hash does not reverse. Resolving a session hashes the token and selects by primary
 * key, which is the same single-row lookup storing it plainly would have been — the safety costs
 * one hash.
 *
 * Compared with a signed cookie (`iron-session` and friends) this is a database read per request
 * against SQLite, which is memory-speed on the same machine. What it buys is revocation, which a
 * signed cookie cannot have: signing out on a shared machine has to invalidate the session rather
 * than ask whoever holds it to stop presenting it.
 *
 * ### A sliding expiry, written rarely
 *
 * A session lasts {@link SESSION_TTL} and renews when it is more than halfway through. Renewing on
 * every request would make every page view a database write; never renewing would sign out somebody
 * who has been using the admin all week. Halfway is the usual compromise and the reason
 * `lastSeenAt` exists.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, not } from 'drizzle-orm';
import { roleOf } from './accounts.js';
import { db } from './db/index.js';
import { sessions, users } from './db/schema.js';
import type { Role } from './db/schema.js';

/** The cookie a session token travels in. */
export const SESSION_COOKIE = 'creator_session';

/**
 * How long a session lasts, in seconds.
 *
 * Thirty days, renewed on use. Long enough that a creator who posts weekly is not signed out
 * between sessions, short enough that an abandoned browser does not stay signed in indefinitely.
 */
export const SESSION_TTL = 30 * 24 * 60 * 60;

/**
 * How much of its life a session must have used before a renewal is written.
 *
 * Half. See the note at the top: the alternative is a write per request.
 */
const RENEW_AFTER = SESSION_TTL / 2;

/**
 * How many bytes of randomness a token carries.
 *
 * 32 bytes — 256 bits — base64url encoded. Far past guessing, and the same size as the hash it is
 * keyed by, so neither is the weaker half.
 */
const TOKEN_BYTES = 32;

/** Who is signed in, as every caller needs them. */
export interface Principal {
	readonly userId: string;
	readonly name: string;
	readonly avatarUrl: string | null;
	readonly role: Role;
}

/** A session as resolved from a token, with the principal it belongs to. */
export interface ResolvedSession {
	readonly principal: Principal;

	/** Unix seconds. Already renewed if it was due, so this is the current expiry. */
	readonly expiresAt: number;
}

/** Unix seconds, which is what every timestamp in the schema is. */
function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * The lookup key for a token.
 *
 * SHA-256 rather than a password hash, deliberately. A password is low-entropy and needs a slow
 * hash to survive being guessed; a 256-bit random token has nothing to guess, so the slow hash would
 * cost a request's latency and buy nothing.
 */
function keyFor(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether two tokens are the same, in constant time.
 *
 * Not used by {@link resolve}, which compares hashes through a primary-key lookup and never a
 * string. Exported for the one caller that does have to compare a token it was given against one it
 * generated — a state parameter, a one-time link — where an early-exit `===` leaks the position of
 * the first difference.
 */
export function sameToken(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');

	// Compared only when the lengths match: `timingSafeEqual` throws on a mismatch, and the length
	// of a token is not a secret.
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Starts a session for a user.
 *
 * @returns the token to put in the cookie, and when it expires. The token is not stored and cannot
 *          be recovered from the row, so a caller that loses it has to issue another.
 */
export function issue(userId: string): { readonly token: string; readonly expiresAt: number } {
	const token = randomBytes(TOKEN_BYTES).toString('base64url');
	const expiresAt = now() + SESSION_TTL;

	db()
		.insert(sessions)
		.values({ id: keyFor(token), userId, expiresAt, lastSeenAt: now() })
		.run();

	return { token, expiresAt };
}

/**
 * Who a token belongs to, or null.
 *
 * Null for a token that does not exist, one whose session has expired, and one whose user has been
 * deleted — three cases a caller has no reason to tell apart, because the answer to all of them is
 * "sign in".
 *
 * An expired row is deleted on the way past rather than left for the sweep. It costs one write on a
 * request that was already going to be refused, and it means an abandoned installation does not
 * accumulate rows forever without anything ever calling {@link sweep}.
 */
export function resolve(token: string): ResolvedSession | null {
	const id = keyFor(token);

	const [found] = db()
		.select({
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt,
			userId: users.id,
			name: users.name,
			avatarUrl: users.avatarUrl,
			role: users.role
		})
		.from(sessions)
		// An inner join, so a session whose user is gone resolves to nothing rather than to a
		// principal with no name. `onDelete: 'cascade'` should have removed it; this does not depend
		// on that having worked.
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, id))
		.all();

	if (found === undefined) return null;

	const at = now();

	if (found.expiresAt <= at) {
		db().delete(sessions).where(eq(sessions.id, id)).run();

		return null;
	}

	const expiresAt = renew(id, found.expiresAt, at);

	return {
		expiresAt,
		principal: {
			userId: found.userId,
			name: found.name,
			avatarUrl: found.avatarUrl,
			// Checked rather than trusted: the column is a typed string, not a constraint.
			role: roleOf(found.role)
		}
	};
}

/**
 * Extends a session if it is more than halfway through its life.
 *
 * @returns the expiry the caller should now report, renewed or not
 */
function renew(id: string, expiresAt: number, at: number): number {
	const remaining = expiresAt - at;

	if (remaining > RENEW_AFTER) return expiresAt;

	const extended = at + SESSION_TTL;

	db()
		.update(sessions)
		.set({ expiresAt: extended, lastSeenAt: at })
		.where(eq(sessions.id, id))
		.run();

	return extended;
}

/**
 * Ends one session — signing out on this device.
 *
 * Takes the token rather than a session id, because the token is what the caller has. Silent when
 * there is nothing to delete: a sign-out that reports "no such session" tells a caller nothing they
 * can act on, and the cookie is cleared either way.
 */
export function revoke(token: string): void {
	db()
		.delete(sessions)
		.where(eq(sessions.id, keyFor(token)))
		.run();
}

/**
 * Ends every session a user has — signing out everywhere.
 *
 * The reason sessions are rows at all. `except` keeps the caller's own session alive, which is what
 * "sign out my other devices" means and what makes the button usable without signing yourself out.
 *
 * @returns how many sessions ended
 */
export function revokeAll(userId: string, options?: { readonly except?: string }): number {
	const keep = options?.except;
	const where =
		keep === undefined
			? eq(sessions.userId, userId)
			: and(eq(sessions.userId, userId), not(eq(sessions.id, keyFor(keep))));

	return db().delete(sessions).where(where).run().changes;
}

/**
 * Deletes expired sessions.
 *
 * Not required for correctness — {@link resolve} refuses an expired session and deletes it on the
 * way past — so this is housekeeping for rows nobody ever comes back for. Returns the count so a
 * caller can log something meaningful rather than "done".
 */
export function sweep(): number {
	return db().delete(sessions).where(lt(sessions.expiresAt, now())).run().changes;
}
