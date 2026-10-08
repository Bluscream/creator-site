/**
 * That an API token is a key to a row, that the row decides what it may do, and that nothing
 * anywhere can produce the secret a second time.
 *
 * Against a real in-memory SQLite, for the reasons `session.test.ts` gives: the properties under
 * test are the database's. The primary key being the hash is what makes the token unrecoverable, the
 * join to `users` is what makes a demotion immediate, and `expires_at < now` against a NULL is a
 * SQL behaviour this module depends on without writing a condition for it.
 *
 * The assertions that matter most here are the negative ones — what is *not* in the database, what
 * is *not* returned twice, what a lapsed token does *not* do — because every one of them is a thing
 * that would work fine in a browser and be a credential leak in a log.
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
	MAX_NAME,
	MAX_PER_USER,
	TOKEN_PREFIX,
	abilityOf,
	create,
	listOf,
	looksLikeToken,
	permits,
	resolve,
	revoke,
	revokeAll,
	rotate,
	sweep,
	tokenFromHeader
} = await import('./api-tokens.js');

const { signIn } = await import('./accounts.js');

const DAY = 24 * 60 * 60;

let database: OpenMemoryDb;
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

/** Every `api_tokens` row, as the database literally holds it. */
function rows(): readonly Record<string, unknown>[] {
	return database.rows('SELECT * FROM api_tokens');
}

/** Moves the clock forward from now. */
function advance(seconds: number): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

/** A token, with the parts a case does not care about chosen for it. */
function issued(overrides: Partial<Parameters<typeof create>[1]> = {}) {
	const made = create(user, { name: 'a script', ability: 'read', lifetime: null, ...overrides });

	if (typeof made === 'string') throw new Error(`could not create a token: ${made}`);

	return made;
}

/** The role column, written directly: `signIn` does not hand out roles. */
function setRole(role: string): void {
	database.exec('UPDATE users SET role = ? WHERE id = ?', role, user);
}

describe('the shape of a token', () => {
	it('starts with a prefix, so a secret scanner can recognise it', () => {
		// The point of the prefix. An unprefixed base64 blob in a CI log is indistinguishable from a
		// hash, and nothing — not gitleaks, not this project's own secretlint hook — would flag it.
		expect(issued().token.startsWith('crs_')).toBe(true);
	});

	it('carries 256 bits of randomness after the prefix', () => {
		const random = issued().token.slice(TOKEN_PREFIX.length);

		expect(Buffer.from(random, 'base64url')).toHaveLength(32);
	});

	it('is never the same twice', () => {
		const tokens = new Set(Array.from({ length: 50 }, () => issued().token));

		expect(tokens.size).toBe(50);
	});
});

describe('what the database holds', () => {
	it('does not hold the token', () => {
		const { token } = issued();

		// Every column, as text, searched for the secret. A stricter assertion than checking the
		// columns this module knows about: a column added later that happened to store the token
		// would fail this without anybody remembering to extend the test.
		expect(JSON.stringify(rows())).not.toContain(token.slice(TOKEN_PREFIX.length));
	});

	it('holds the token’s SHA-256 as the row id', () => {
		const { token, id } = issued();

		expect(id).toBe(createHash('sha256').update(token).digest('hex'));
	});

	it('holds a hint that is a true prefix of the token, and far too short to use', () => {
		const { token } = issued();
		const hint = String(rows()[0]?.hint);

		expect(token.startsWith(hint)).toBe(true);
		expect(hint).toHaveLength(TOKEN_PREFIX.length + 6);
	});

	it('records a new token as never used', () => {
		// Not "used at creation time". The difference between never-used and used-recently is the one
		// thing a list of credentials can say that somebody acts on.
		issued();

		expect(rows()[0]?.last_used_at).toBeNull();
	});
});

describe('create', () => {
	it('refuses a name that is only whitespace', () => {
		expect(create(user, { name: '   ', ability: 'read', lifetime: null })).toBe('no_name');
	});

	it('writes nothing when it refuses', () => {
		create(user, { name: '', ability: 'read', lifetime: null });

		expect(rows()).toHaveLength(0);
	});

	it('trims the name rather than storing the spaces somebody pasted', () => {
		issued({ name: '  uptime check  ' });

		expect(rows()[0]?.name).toBe('uptime check');
	});

	it('truncates a name past the limit instead of refusing it', () => {
		// A label is not data: silently shortening one is kinder than rejecting a form over it.
		issued({ name: 'x'.repeat(MAX_NAME + 50) });

		expect(String(rows()[0]?.name)).toHaveLength(MAX_NAME);
	});

	it('stores no expiry for a token asked to live forever', () => {
		issued({ lifetime: null });

		expect(rows()[0]?.expires_at).toBeNull();
	});

	it('turns a lifetime into an absolute expiry', () => {
		issued({ lifetime: 30 * DAY });

		expect(Number(rows()[0]?.expires_at)).toBeCloseTo(Math.floor(Date.now() / 1000) + 30 * DAY, -1);
	});

	it('refuses once somebody holds the maximum', () => {
		for (let index = 0; index < MAX_PER_USER; index += 1)
			issued({ name: `token ${String(index)}` });

		expect(create(user, { name: 'one more', ability: 'read', lifetime: null })).toBe('too_many');
	});

	it('counts only live tokens towards the maximum', () => {
		// An expired row is not a credential anybody holds, so it must not be what stops somebody
		// making a working one. Without this, a daily-rotating script would lock itself out.
		for (let index = 0; index < MAX_PER_USER; index += 1) {
			issued({ name: `token ${String(index)}`, lifetime: DAY });
		}

		advance(2 * DAY);

		expect(create(user, { name: 'one more', ability: 'read', lifetime: null })).not.toBe(
			'too_many'
		);
	});
});

describe('resolve', () => {
	it('finds the owner of a token', () => {
		const { token } = issued();

		expect(resolve(token)?.principal.userId).toBe(user);
	});

	it('reports the token’s ability', () => {
		const { token } = issued({ ability: 'write' });

		expect(resolve(token)?.ability).toBe('write');
	});

	it('reports the row id, so a log can name the credential without quoting it', () => {
		const made = issued();

		expect(resolve(made.token)?.id).toBe(made.id);
	});

	it('refuses a token nobody issued', () => {
		expect(resolve(`${TOKEN_PREFIX}not-a-real-token`)).toBeNull();
	});

	it('refuses something that is not one of ours at all', () => {
		expect(resolve('Basic YWRtaW46aHVudGVyMg==')).toBeNull();
	});

	it('refuses a token whose expiry has passed', () => {
		const { token } = issued({ lifetime: DAY });

		advance(DAY + 1);

		expect(resolve(token)).toBeNull();
	});

	it('deletes the row of an expired token on the way past', () => {
		const { token } = issued({ lifetime: DAY });

		advance(DAY + 1);
		resolve(token);

		expect(rows()).toHaveLength(0);
	});

	it('accepts a token with no expiry however long it has been', () => {
		const { token } = issued({ lifetime: null });

		advance(3650 * DAY);

		expect(resolve(token)).not.toBeNull();
	});

	it('refuses a token whose user has been deleted', () => {
		const { token } = issued();

		database.exec('DELETE FROM users WHERE id = ?', user);

		expect(resolve(token)).toBeNull();
	});

	it('reports the owner’s role as it is now, not as it was', () => {
		// The reason no role is stored on the row. A demotion has to reach the credentials somebody
		// already issued, or it is not a demotion.
		setRole('owner');

		const { token } = issued();

		expect(resolve(token)?.principal.role).toBe('owner');

		setRole('member');

		expect(resolve(token)?.principal.role).toBe('member');
	});

	it('treats an unrecognised stored ability as read-only', () => {
		// A column, not a constraint. A value no version ever wrote — or one from a future version
		// that added an ability — must not fall through as permission to write.
		const { token } = issued();

		database.exec('UPDATE api_tokens SET ability = ?', 'superuser');

		expect(resolve(token)?.ability).toBe('read');
	});

	it('records when a token was first used', () => {
		const { token } = issued();

		resolve(token);

		expect(rows()[0]?.last_used_at).not.toBeNull();
	});

	it('does not write again for a token used twice in a minute', () => {
		// A write per API call is what this throttle exists to avoid. Asserted on the stored value
		// rather than by counting writes, because the value is what a reader would see.
		const { token } = issued();

		resolve(token);

		const first = rows()[0]?.last_used_at;

		advance(60);
		resolve(token);

		expect(rows()[0]?.last_used_at).toBe(first);
	});

	it('writes again once the record is more than an hour old', () => {
		const { token } = issued();

		resolve(token);

		const first = Number(rows()[0]?.last_used_at);

		advance(2 * 60 * 60);
		resolve(token);

		expect(Number(rows()[0]?.last_used_at)).toBeGreaterThan(first);
	});
});

describe('listOf', () => {
	it('shows a token without its secret', () => {
		const { token } = issued();
		const [listed] = listOf(user);

		expect(JSON.stringify(listed)).not.toContain(token.slice(TOKEN_PREFIX.length));
		expect(listed?.hint).toBe(token.slice(0, TOKEN_PREFIX.length + 6));
	});

	it('shows newest first', () => {
		issued({ name: 'older' });
		advance(60);
		issued({ name: 'newer' });

		expect(listOf(user).map((row) => row.name)).toStrictEqual(['newer', 'older']);
	});

	it('leaves out an expired token', () => {
		issued({ name: 'lapsed', lifetime: DAY });

		advance(DAY + 1);

		expect(listOf(user)).toHaveLength(0);
	});

	it('does not delete the expired token it left out', () => {
		// A read that wrote would surprise the next person who added a caller. `sweep` deletes.
		issued({ lifetime: DAY });

		advance(DAY + 1);
		listOf(user);

		expect(rows()).toHaveLength(1);
	});

	it('shows nothing belonging to somebody else', () => {
		issued();

		const other = signIn(
			{ provider: 'discord', providerUserId: '2', name: 'Else' },
			{
				register: true
			}
		);

		if (!other.ok) throw new Error('could not create the second user');

		expect(listOf(other.principal.userId)).toHaveLength(0);
	});
});

describe('rotate', () => {
	it('returns a different token', () => {
		const first = issued();
		const second = rotate(user, first.id);

		expect(second?.token).not.toBe(first.token);
	});

	it('stops the old token working', () => {
		const first = issued();

		rotate(user, first.id);

		expect(resolve(first.token)).toBeNull();
	});

	it('makes the new token work', () => {
		const first = issued();
		const second = rotate(user, first.id);

		expect(second === null ? null : resolve(second.token)?.principal.userId).toBe(user);
	});

	it('leaves exactly one row', () => {
		const first = issued();

		rotate(user, first.id);

		expect(rows()).toHaveLength(1);
	});

	it('keeps the name and the ability', () => {
		const first = issued({ name: 'backup script', ability: 'write' });

		rotate(user, first.id);

		const [listed] = listOf(user);

		expect(listed?.name).toBe('backup script');
		expect(listed?.ability).toBe('write');
	});

	it('keeps the expiry rather than extending it', () => {
		// Rotating is "this secret may have leaked", not "give me another year". A rotation that
		// pushed the expiry out would make a deliberately short-lived token immortal by maintenance.
		const first = issued({ lifetime: 10 * DAY });
		const before = rows()[0]?.expires_at;

		advance(5 * DAY);
		rotate(user, first.id);

		expect(rows()[0]?.expires_at).toBe(before);
	});

	it('keeps a token that was already expired expired', () => {
		const first = issued({ lifetime: DAY });

		advance(DAY + 1);

		const second = rotate(user, first.id);

		expect(second === null ? null : resolve(second.token)).toBeNull();
	});

	it('keeps the original creation time, because the grant is that old', () => {
		const first = issued();
		const before = rows()[0]?.created_at;

		advance(30 * DAY);
		rotate(user, first.id);

		expect(rows()[0]?.created_at).toBe(before);
	});

	it('marks the new secret as never used, even though the old one was', () => {
		const first = issued();

		resolve(first.token);
		rotate(user, first.id);

		expect(rows()[0]?.last_used_at).toBeNull();
	});

	it('refuses an id belonging to somebody else, and changes nothing', () => {
		const first = issued();

		const other = signIn(
			{ provider: 'discord', providerUserId: '2', name: 'Else' },
			{
				register: true
			}
		);

		if (!other.ok) throw new Error('could not create the second user');

		expect(rotate(other.principal.userId, first.id)).toBeNull();

		// The token somebody else tried to rotate still works, which is the half that would be a
		// denial of service if the scoping were only on the read.
		expect(resolve(first.token)).not.toBeNull();
	});

	it('refuses an id that does not exist', () => {
		expect(rotate(user, 'nope')).toBeNull();
	});
});

describe('revoke', () => {
	it('stops the token working', () => {
		const made = issued();

		revoke(user, made.id);

		expect(resolve(made.token)).toBeNull();
	});

	it('says whether anything was removed', () => {
		const made = issued();

		expect(revoke(user, made.id)).toBe(true);
		expect(revoke(user, made.id)).toBe(false);
	});

	it('will not remove somebody else’s', () => {
		const made = issued();

		const other = signIn(
			{ provider: 'discord', providerUserId: '2', name: 'Else' },
			{
				register: true
			}
		);

		if (!other.ok) throw new Error('could not create the second user');

		expect(revoke(other.principal.userId, made.id)).toBe(false);
		expect(resolve(made.token)).not.toBeNull();
	});
});

describe('revokeAll', () => {
	it('removes every token the user holds, and reports how many', () => {
		issued({ name: 'one' });
		issued({ name: 'two' });

		expect(revokeAll(user)).toBe(2);
		expect(rows()).toHaveLength(0);
	});

	it('leaves somebody else’s alone', () => {
		const other = signIn(
			{ provider: 'discord', providerUserId: '2', name: 'Else' },
			{
				register: true
			}
		);

		if (!other.ok) throw new Error('could not create the second user');

		const theirs = create(other.principal.userId, {
			name: 'theirs',
			ability: 'read',
			lifetime: null
		});

		if (typeof theirs === 'string') throw new Error('could not create their token');

		issued();

		expect(revokeAll(user)).toBe(1);
		expect(resolve(theirs.token)).not.toBeNull();
	});
});

describe('sweep', () => {
	it('deletes an expired token', () => {
		issued({ lifetime: DAY });

		advance(DAY + 1);

		expect(sweep()).toBe(1);
	});

	it('leaves a live one', () => {
		issued({ lifetime: 10 * DAY });

		advance(DAY);

		expect(sweep()).toBe(0);
	});

	it('leaves a token that does not expire', () => {
		// The SQL behaviour this module relies on without writing a condition for it: `expires_at <
		// now` is NULL rather than true for a NULL column, so a non-expiring token survives. Correct,
		// not obvious, and a `COALESCE` added to that predicate by somebody tidying up would delete
		// every permanent token in the installation.
		issued({ lifetime: null });

		advance(3650 * DAY);

		expect(sweep()).toBe(0);
		expect(rows()).toHaveLength(1);
	});
});

describe('deleting a user', () => {
	it('takes their tokens with them', () => {
		// `onDelete: 'cascade'`, which is only real if the connection has `PRAGMA foreign_keys` on.
		// A credential outliving the account it acts as would be the worst row in the table.
		issued();

		database.exec('DELETE FROM users WHERE id = ?', user);

		expect(rows()).toHaveLength(0);
	});
});

describe('permits', () => {
	it.each([
		['write may write', 'write', 'write', true],
		['write may read', 'write', 'read', true],
		['read may read', 'read', 'read', true],
		['read may not write', 'read', 'write', false]
	] as const)('%s', (_what, held, needed, expected) => {
		expect(permits(held, needed)).toBe(expected);
	});

	it('refuses an ability it does not recognise, rather than treating it as the widest', () => {
		// @ts-expect-error -- the point is a value the type forbids, which a database can still hold
		expect(permits('superuser', 'read')).toBe(false);
	});
});

describe('abilityOf', () => {
	it.each([
		['write', 'write'],
		['read', 'read'],
		['anything else', 'read'],
		[null, 'read'],
		[undefined, 'read']
	] as const)('%s becomes the narrowest it can', (value, expected) => {
		expect(abilityOf(value === 'anything else' ? 'nonsense' : value)).toBe(expected);
	});
});

describe('looksLikeToken', () => {
	it.each([
		['one of ours', `${TOKEN_PREFIX}abc`, true],
		['the bare prefix', TOKEN_PREFIX, false],
		['a credential with somebody else’s prefix', 'other_0123456789', false],
		['nothing at all', '', false]
	] as const)('%s', (_what, value, expected) => {
		expect(looksLikeToken(value)).toBe(expected);
	});

	it('costs no database read for a value that is not ours', () => {
		// The reason this function exists rather than hashing whatever arrived: an `Authorization`
		// header full of somebody else's credential should not be a query, and should certainly not
		// be hashed into something that looks like a lookup key in a profiler.
		open.current = null;

		expect(() => resolve('Bearer-ish nonsense')).not.toThrow();
	});
});

describe('tokenFromHeader', () => {
	it.each([
		['a bearer token', 'Bearer crs_abc', 'crs_abc'],
		['a lowercase scheme, which several clients send', 'bearer crs_abc', 'crs_abc'],
		['an uppercase scheme', 'BEARER crs_abc', 'crs_abc'],
		['trailing whitespace somebody pasted in', 'Bearer crs_abc  ', 'crs_abc'],
		['no header at all', null, null],
		['basic auth, which is somebody else’s credential', 'Basic YWRtaW46aHVudGVyMg==', null],
		['a bare token with no scheme', 'crs_abc', null],
		['a scheme with nothing after it', 'Bearer', null],
		['a scheme with only spaces after it', 'Bearer   ', null]
	] as const)('%s', (_what, header, expected) => {
		expect(tokenFromHeader(header)).toBe(expected);
	});

	it('does not treat a scheme-less header as a token', () => {
		// The case that decides whether the cookie still works behind a proxy that adds its own
		// `Authorization`. Treating that as a failed token presentation would sign the creator out of
		// their own admin, and the cause would be two layers away from the symptom.
		expect(tokenFromHeader('Negotiate YII=')).toBeNull();
	});
});
