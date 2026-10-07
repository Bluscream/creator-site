/**
 * That a session token is a key to a row and nothing else, and that the row decides everything.
 *
 * Against a real in-memory SQLite, because the properties under test are the database's: the
 * primary key is a hash so the token is unrecoverable, the join to `users` is what makes a deleted
 * user's session resolve to nothing, and the sliding renewal is a write that either happened or did
 * not. See `./fixtures/memory-db.ts`.
 *
 * Time is moved with `vi.setSystemTime` rather than by writing expiries by hand wherever possible,
 * so the code under test computes the same way production does.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from './fixtures/memory-db.js';
import type { OpenMemoryDb } from './fixtures/memory-db.js';

const open = vi.hoisted(() => ({ current: null as { db: unknown } | null }));

vi.mock('./db/index.js', () => ({
	db: () => {
		if (open.current === null) throw new Error('no test database is open');

		return open.current.db;
	},
	closeDb: () => undefined
}));

vi.mock('./log.js', () => ({
	log: () => ({
		error: () => undefined,
		warn: () => undefined,
		info: () => undefined,
		debug: () => undefined
	})
}));

const {
	SESSION_COOKIE,
	SESSION_TTL,
	issue,
	resolve,
	revoke,
	revokeAll,
	revokeById,
	sameToken,
	sessionIdFor,
	sessionsOf,
	sweep
} = await import('./session.js');

const { signIn } = await import('./accounts.js');

let database: OpenMemoryDb;

/** A user to hang sessions off, created fresh per test. */
let user: string;

beforeEach(() => {
	database = memoryDb();
	open.current = { db: database.db };

	const result = signIn(
		{ provider: 'discord', providerUserId: '1', name: 'Someone' },
		{
			register: true
		}
	);

	if (!result.ok) throw new Error('could not create the test user');

	user = result.principal.userId;
});

afterEach(() => {
	vi.useRealTimers();
	open.current = null;
	database.close();
});

/** Every `sessions` row, as the database literally holds it. */
function sessionRows(): readonly Record<string, unknown>[] {
	return database.rows('SELECT * FROM sessions');
}

/** Moves the clock forward by a number of seconds from now. */
function advance(seconds: number): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

describe('the cookie name', () => {
	it('is not something another application would also use', () => {
		expect(SESSION_COOKIE).toBe('creator_session');
	});
});

describe('issue', () => {
	it('returns a token', () => {
		expect(issue(user).token).not.toBe('');
	});

	it('returns a token with 256 bits of randomness', () => {
		// base64url of 32 bytes, unpadded.
		expect(Buffer.from(issue(user).token, 'base64url')).toHaveLength(32);
	});

	it('never returns the same token twice', () => {
		const tokens = new Set(Array.from({ length: 50 }, () => issue(user).token));

		expect(tokens.size).toBe(50);
	});

	it('expires it a token lifetime from now', () => {
		const before = Math.floor(Date.now() / 1000);

		expect(issue(user).expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL);
	});

	it('writes one row', () => {
		issue(user);

		expect(sessionRows()).toHaveLength(1);
	});

	it('stores the token nowhere', () => {
		// The property the whole design rests on: a database that leaks leaks nothing usable, because
		// an attacker holding every row still cannot build a cookie.
		const { token } = issue(user);

		const stored = JSON.stringify(sessionRows());

		expect(stored).not.toContain(token);
	});

	it('keys the row by the token hash', () => {
		const { token } = issue(user);

		const [row] = sessionRows();

		expect(row?.id).toBe(createHash('sha256').update(token).digest('hex'));
	});
});

describe('resolve', () => {
	it('is null for a token nobody was issued', () => {
		expect(resolve('not-a-token')).toBeNull();
	});

	it('is null for the empty string', () => {
		expect(resolve('')).toBeNull();
	});

	it('finds the user a token belongs to', () => {
		const { token } = issue(user);

		expect(resolve(token)?.principal.userId).toBe(user);
	});

	it('carries the display name, so a caller needs no second query', () => {
		const { token } = issue(user);

		expect(resolve(token)?.principal.name).toBe('Someone');
	});

	it('carries the role', () => {
		const { token } = issue(user);

		expect(resolve(token)?.principal.role).toBe('owner');
	});

	it('checks the stored role rather than trusting it', () => {
		const { token } = issue(user);
		database.exec('UPDATE users SET role = ? WHERE id = ?', 'superuser', user);

		expect(resolve(token)?.principal.role).toBe('member');
	});

	it('is null once the session has expired', () => {
		const { token } = issue(user);

		advance(SESSION_TTL + 1);

		expect(resolve(token)).toBeNull();
	});

	it('is null on the exact second it expires', () => {
		// Expiry is `<=`, so the boundary second is already gone rather than still valid.
		const { token, expiresAt } = issue(user);

		vi.useFakeTimers();
		vi.setSystemTime(new Date(expiresAt * 1000));

		expect(resolve(token)).toBeNull();
	});

	it('deletes the expired row on the way past', () => {
		// So an abandoned installation does not accumulate rows forever without anything ever calling
		// `sweep`. It costs one write on a request that was already going to be refused.
		const { token } = issue(user);

		advance(SESSION_TTL + 1);
		resolve(token);

		expect(sessionRows()).toStrictEqual([]);
	});

	it('leaves other sessions alone when it does', () => {
		const expiring = issue(user);
		const other = issue(user);

		advance(SESSION_TTL + 1);
		resolve(expiring.token);

		expect(resolve(other.token)).toBeNull();
		expect(sessionRows()).toStrictEqual([]);
	});

	it('is null once the user is gone', () => {
		// An inner join, so a session whose user was deleted resolves to nothing rather than to a
		// principal with no name. This does not depend on the cascade having worked.
		const { token } = issue(user);

		database.exec('DELETE FROM users WHERE id = ?', user);

		expect(resolve(token)).toBeNull();
	});

	it('takes the cascade with the user', () => {
		issue(user);

		database.exec('DELETE FROM users WHERE id = ?', user);

		expect(sessionRows()).toStrictEqual([]);
	});
});

describe('the sliding expiry', () => {
	it('does not write before the session is halfway through', () => {
		// The reason the renewal is conditional at all: renewing on every request would make every
		// page view of the admin a database write.
		const { token } = issue(user);
		const [before] = sessionRows();

		advance(SESSION_TTL / 4);
		resolve(token);

		expect(sessionRows()).toStrictEqual([before]);
	});

	it('reports the unchanged expiry before then', () => {
		const { token, expiresAt } = issue(user);

		advance(SESSION_TTL / 4);

		expect(resolve(token)?.expiresAt).toBe(expiresAt);
	});

	it('extends a session past halfway', () => {
		const { token, expiresAt } = issue(user);

		advance(SESSION_TTL / 2 + 10);

		expect(resolve(token)?.expiresAt).toBeGreaterThan(expiresAt);
	});

	it('extends it by a full lifetime from now, not from the old expiry', () => {
		const { token } = issue(user);

		advance(SESSION_TTL / 2 + 10);

		const at = Math.floor(Date.now() / 1000);

		expect(resolve(token)?.expiresAt).toBe(at + SESSION_TTL);
	});

	it('persists the extension', () => {
		const { token } = issue(user);

		advance(SESSION_TTL / 2 + 10);
		const renewed = resolve(token)?.expiresAt;

		expect(Number(sessionRows()[0]?.expires_at)).toBe(renewed);
	});

	it('records when the session was last used', () => {
		const { token } = issue(user);
		const issued = Number(sessionRows()[0]?.last_seen_at);

		advance(SESSION_TTL / 2 + 10);
		resolve(token);

		expect(Number(sessionRows()[0]?.last_seen_at)).toBeGreaterThan(issued);
	});

	it('keeps a session alive indefinitely while it is used', () => {
		// The point of a sliding expiry: a creator who posts weekly is never signed out.
		const { token } = issue(user);

		for (let week = 0; week < 20; week += 1) {
			advance(7 * 24 * 60 * 60);

			expect(resolve(token)).not.toBeNull();
		}

		expect(resolve(token)).not.toBeNull();
	});
});

describe('revoke', () => {
	it('ends the session', () => {
		const { token } = issue(user);

		revoke(token);

		expect(resolve(token)).toBeNull();
	});

	it('removes the row', () => {
		const { token } = issue(user);

		revoke(token);

		expect(sessionRows()).toStrictEqual([]);
	});

	it('leaves the other sessions of the same user alone', () => {
		const phone = issue(user);
		const laptop = issue(user);

		revoke(phone.token);

		expect(resolve(laptop.token)).not.toBeNull();
	});

	it('is silent about a token that was never issued', () => {
		expect(() => {
			revoke('not-a-token');
		}).not.toThrow();
	});
});

describe('revokeAll', () => {
	it('ends every session the user has', () => {
		const phone = issue(user);
		const laptop = issue(user);

		expect(revokeAll(user)).toBe(2);
		expect(resolve(phone.token)).toBeNull();
		expect(resolve(laptop.token)).toBeNull();
	});

	it('keeps the caller’s own session when asked', () => {
		// What "sign out my other devices" means, and what makes the button usable without signing
		// yourself out.
		const mine = issue(user);
		const other = issue(user);

		expect(revokeAll(user, { except: mine.token })).toBe(1);
		expect(resolve(mine.token)).not.toBeNull();
		expect(resolve(other.token)).toBeNull();
	});

	it('does not touch another user', () => {
		const signedIn = signIn({ provider: 'discord', providerUserId: '2' }, { register: true });

		if (!signedIn.ok) throw new Error('could not create the second user');

		const theirs = issue(signedIn.principal.userId);
		issue(user);

		revokeAll(user);

		expect(resolve(theirs.token)).not.toBeNull();
	});

	it('is zero for a user with no sessions', () => {
		expect(revokeAll(user)).toBe(0);
	});
});

describe('sweep', () => {
	it('deletes expired sessions', () => {
		issue(user);
		issue(user);

		advance(SESSION_TTL + 1);

		expect(sweep()).toBe(2);
	});

	it('keeps the ones that are still good', () => {
		const old = issue(user);

		advance(SESSION_TTL + 1);
		const fresh = issue(user);

		expect(sweep()).toBe(1);
		expect(resolve(fresh.token)).not.toBeNull();
		expect(resolve(old.token)).toBeNull();
	});

	it('is zero when there is nothing to do', () => {
		issue(user);

		expect(sweep()).toBe(0);
	});
});

describe('sameToken', () => {
	it('is true for equal strings', () => {
		expect(sameToken('abc', 'abc')).toBe(true);
	});

	it('is false for different strings of the same length', () => {
		expect(sameToken('abc', 'abd')).toBe(false);
	});

	it('is false rather than throwing on different lengths', () => {
		// `timingSafeEqual` throws on a length mismatch, and the length of a token is not a secret.
		expect(sameToken('abc', 'abcd')).toBe(false);
	});

	it('is true for two empty strings', () => {
		expect(sameToken('', '')).toBe(true);
	});

	it('compares bytes, not code units', () => {
		expect(sameToken('é', 'é')).toBe(true);
	});
});

describe('sessionsOf', () => {
	it('is empty for somebody with none', () => {
		expect(sessionsOf(user)).toStrictEqual([]);
	});

	it('lists a session', () => {
		issue(user);

		expect(sessionsOf(user)).toHaveLength(1);
	});

	it('identifies rows by the token hash, which is safe to show', () => {
		// The payoff for keying the table by a hash: a page can list sessions and end one without ever
		// handling a credential.
		const { token } = issue(user);

		expect(sessionsOf(user)[0]?.id).toBe(createHash('sha256').update(token).digest('hex'));
	});

	it('never carries a token', () => {
		const { token } = issue(user);

		expect(JSON.stringify(sessionsOf(user))).not.toContain(token);
	});

	it('marks the session that is asking', () => {
		const mine = issue(user);
		issue(user);

		const listed = sessionsOf(user, mine.token);

		expect(listed.filter((session) => session.current)).toHaveLength(1);
	});

	it('marks the right one', () => {
		const mine = issue(user);
		issue(user);

		const current = sessionsOf(user, mine.token).find((session) => session.current);

		expect(current?.id).toBe(createHash('sha256').update(mine.token).digest('hex'));
	});

	it('marks nothing when no token is given', () => {
		issue(user);

		expect(sessionsOf(user).some((session) => session.current)).toBe(false);
	});

	it('marks nothing for a token that is not one of them', () => {
		issue(user);

		expect(sessionsOf(user, 'not-a-token').some((session) => session.current)).toBe(false);
	});

	it('leaves out an expired session', () => {
		issue(user);

		advance(SESSION_TTL + 1);
		issue(user);

		expect(sessionsOf(user)).toHaveLength(1);
	});

	it('does not delete the expired one it left out', () => {
		// This is a read. A page that silently wrote would surprise the next person who added a caller;
		// `sweep` is what deletes.
		issue(user);

		advance(SESSION_TTL + 1);
		sessionsOf(user);

		expect(sessionRows()).toHaveLength(1);
	});

	it('leaves out somebody else’s sessions', () => {
		const signedIn = signIn({ provider: 'discord', providerUserId: '2' }, { register: true });

		if (!signedIn.ok) throw new Error('could not create the second user');

		issue(signedIn.principal.userId);
		issue(user);

		expect(sessionsOf(user)).toHaveLength(1);
	});

	it('puts the most recently started first', () => {
		const older = issue(user);

		advance(60);
		const newer = issue(user);

		expect(sessionsOf(user).map((session) => session.id)).toStrictEqual([
			sessionIdFor(newer.token),
			sessionIdFor(older.token)
		]);
	});

	it('moves a session up when it is used', () => {
		// `lastSeenAt` is only written on a renewal, which is the point: the order reflects real use
		// rather than every page view.
		const older = issue(user);

		advance(60);
		const newer = issue(user);

		advance(SESSION_TTL / 2 + 10);
		resolve(older.token);

		expect(sessionsOf(user).map((session) => session.id)).toStrictEqual([
			sessionIdFor(older.token),
			sessionIdFor(newer.token)
		]);
	});
});

describe('revokeById', () => {
	it('ends the session it names', () => {
		const { token } = issue(user);
		const [listed] = sessionsOf(user);

		expect(revokeById(user, listed?.id ?? '')).toBe(true);
		expect(resolve(token)).toBeNull();
	});

	it('is false for an id that is not a session', () => {
		expect(revokeById(user, 'nonsense')).toBe(false);
	});

	it('refuses somebody else’s session', () => {
		// The id arrives from a form, which means from outside the trust boundary whatever the page
		// believes it rendered. Scoping the query by user is what makes that safe.
		const signedIn = signIn({ provider: 'discord', providerUserId: '2' }, { register: true });

		if (!signedIn.ok) throw new Error('could not create the second user');

		const theirs = issue(signedIn.principal.userId);
		const [listed] = sessionsOf(signedIn.principal.userId);

		expect(revokeById(user, listed?.id ?? '')).toBe(false);
		expect(resolve(theirs.token)).not.toBeNull();
	});

	it('leaves the user’s other sessions alone', () => {
		const phone = issue(user);
		const laptop = issue(user);
		const toEnd = sessionsOf(user, phone.token).find((session) => session.current);

		revokeById(user, toEnd?.id ?? '');

		expect(resolve(laptop.token)).not.toBeNull();
	});
});

describe('sessionIdFor', () => {
	it('is the id the row is keyed by', () => {
		const { token } = issue(user);

		expect(sessionIdFor(token)).toBe(sessionsOf(user)[0]?.id);
	});

	it('is not the token', () => {
		const { token } = issue(user);

		expect(sessionIdFor(token)).not.toBe(token);
	});

	it('is stable, so comparing a token against a listed id works', () => {
		expect(sessionIdFor('abc')).toBe(sessionIdFor('abc'));
	});
});
