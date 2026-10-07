/**
 * That an identity from a provider becomes the right account, and only ever one account.
 *
 * Run against a real in-memory SQLite rather than a stubbed `db()`, because the behaviours that
 * matter here are the database's: the unique index on `(provider, provider_user_id)` is what makes a
 * second sign-in find the existing user, and the transaction in `create` is what keeps a user with
 * no identity from existing. See `./fixtures/memory-db.ts`.
 */

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

const logged = vi.hoisted(() => ({ errors: [] as string[] }));

vi.mock('./log.js', () => ({
	log: () => ({
		error: (_: unknown, message: string) => {
			logged.errors.push(message);
		},
		warn: () => undefined,
		info: () => undefined,
		debug: () => undefined
	})
}));

const {
	findByIdentity,
	identitiesOf,
	isUnclaimed,
	linkIdentity,
	people,
	roleOf,
	setRole,
	signIn,
	unlinkIdentity
} = await import('./accounts.js');

const { DEFAULT_ROLE, ROLES } = await import('./db/schema.js');

/** The identity a test signs in with unless it needs a different one. */
const DISCORD = { provider: 'discord', providerUserId: '1', name: 'Someone' };

let database: OpenMemoryDb;

beforeEach(() => {
	database = memoryDb();
	open.current = { db: database.db };
	logged.errors.length = 0;
});

afterEach(() => {
	open.current = null;
	database.close();
});

/** Signs somebody in and returns the principal, failing the test if the sign-in was refused. */
function signedIn(
	identity: Parameters<typeof signIn>[0],
	register = true
): ReturnType<typeof signIn> & { ok: true } {
	const result = signIn(identity, { register });

	if (!result.ok) throw new Error(`sign-in refused: ${result.reason}`);

	return result;
}

describe('roleOf', () => {
	it.each(ROLES)('accepts %s', (role) => {
		expect(roleOf(role)).toBe(role);
	});

	it('fails closed on a role that does not exist', () => {
		// A hand-edited row, or a downgrade from a version that added a role. Trusting it would hand
		// out whatever permissions the string happened to resemble.
		expect(roleOf('superuser')).toBe(DEFAULT_ROLE);
	});

	it('says so in the log when it does', () => {
		roleOf('superuser');

		expect(logged.errors).toHaveLength(1);
	});

	it('fails closed on the empty string', () => {
		expect(roleOf('')).toBe(DEFAULT_ROLE);
	});
});

describe('isUnclaimed', () => {
	it('is true for an installation with no accounts', () => {
		expect(isUnclaimed()).toBe(true);
	});

	it('is false once anyone has signed in', () => {
		signedIn(DISCORD);

		expect(isUnclaimed()).toBe(false);
	});
});

describe('signIn', () => {
	it('creates an account for an identity nobody has seen', () => {
		const result = signedIn(DISCORD);

		expect(result.created).toBe(true);
	});

	it('makes the first account the owner', () => {
		// This is how first-run setup works without a password in a log: whoever reaches a fresh
		// install first owns it.
		expect(signedIn(DISCORD).principal.role).toBe('owner');
	});

	it('gives everyone after the first the narrowest role', () => {
		signedIn(DISCORD);

		const second = signedIn({ provider: 'discord', providerUserId: '2' });

		expect(second.principal.role).toBe(DEFAULT_ROLE);
	});

	it('claims a fresh install even with registration off', () => {
		// The state an installation ships in. If the policy were checked first, a fresh install would
		// be unreachable by anyone, including the person who just deployed it.
		const result = signIn(DISCORD, { register: false });

		expect(result).toMatchObject({ ok: true, created: true });
	});

	it('refuses an unknown identity once the install is claimed and registration is off', () => {
		signedIn(DISCORD);

		const result = signIn({ provider: 'discord', providerUserId: '2' }, { register: false });

		expect(result).toStrictEqual({ ok: false, reason: 'registration_closed' });
	});

	it('still lets an existing user in when registration is off', () => {
		const first = signedIn(DISCORD);

		const again = signIn(DISCORD, { register: false });

		expect(again).toMatchObject({ ok: true, principal: { userId: first.principal.userId } });
	});

	it('finds the same account on a second sign-in rather than creating another', () => {
		const first = signedIn(DISCORD);
		const second = signedIn(DISCORD);

		expect(second.principal.userId).toBe(first.principal.userId);
		expect(second.created).toBe(false);
	});

	it('leaves exactly one user row after signing in twice', () => {
		signedIn(DISCORD);
		signedIn(DISCORD);

		expect(database.rows('SELECT id FROM users')).toHaveLength(1);
	});

	it('treats the same provider id on another provider as a different person', () => {
		const discord = signedIn(DISCORD);
		const google = signedIn({ provider: 'google', providerUserId: '1' });

		expect(google.principal.userId).not.toBe(discord.principal.userId);
	});

	it('refuses an identity with no provider', () => {
		// An empty provider id would make one `identities` row match every future sign-in that also
		// failed to supply one.
		expect(signIn({ provider: '', providerUserId: '1' }, { register: true })).toStrictEqual({
			ok: false,
			reason: 'invalid_identity'
		});
	});

	it('refuses an identity with no provider user id', () => {
		expect(signIn({ provider: 'discord', providerUserId: '' }, { register: true })).toStrictEqual({
			ok: false,
			reason: 'invalid_identity'
		});
	});

	it('writes nothing for a refused identity', () => {
		signIn({ provider: '', providerUserId: '' }, { register: true });

		expect(isUnclaimed()).toBe(true);
	});

	it('falls back to the provider name when the provider gave none', () => {
		expect(signedIn({ provider: 'discord', providerUserId: '1' }).principal.name).toBe('discord');
	});

	it('stores no avatar when the provider gave none', () => {
		expect(signedIn(DISCORD).principal.avatarUrl).toBeNull();
	});

	it('stores the avatar when it did', () => {
		const result = signedIn({ ...DISCORD, avatarUrl: 'https://cdn.example/a.png' });

		expect(result.principal.avatarUrl).toBe('https://cdn.example/a.png');
	});

	it('creates the user and the identity together', () => {
		const result = signedIn(DISCORD);

		expect(database.rows('SELECT user_id FROM identities')).toStrictEqual([
			{ user_id: result.principal.userId }
		]);
	});
});

describe('signIn, on a returning user', () => {
	it('picks up a new display name', () => {
		signedIn(DISCORD);

		const again = signedIn({ ...DISCORD, name: 'Renamed' });

		expect(again.principal.name).toBe('Renamed');
	});

	it('persists it rather than only returning it', () => {
		signedIn(DISCORD);
		signedIn({ ...DISCORD, name: 'Renamed' });

		expect(findByIdentity('discord', '1')?.name).toBe('Renamed');
	});

	it('picks up a new avatar', () => {
		signedIn({ ...DISCORD, avatarUrl: 'https://cdn.example/old.png' });

		const again = signedIn({ ...DISCORD, avatarUrl: 'https://cdn.example/new.png' });

		expect(again.principal.avatarUrl).toBe('https://cdn.example/new.png');
	});

	it('keeps the stored name when the provider sent none', () => {
		signedIn({ ...DISCORD, name: 'Someone' });

		expect(signedIn({ provider: 'discord', providerUserId: '1' }).principal.name).toBe('Someone');
	});

	it('never changes the role', () => {
		// The role belongs to this installation, not to Discord. An owner who renames themselves is
		// still the owner.
		const first = signedIn(DISCORD);
		const again = signedIn({ ...DISCORD, name: 'Renamed' });

		expect(again.principal.role).toBe(first.principal.role);
	});

	it('checks the stored role rather than trusting it', () => {
		const first = signedIn(DISCORD);

		database.exec('UPDATE users SET role = ? WHERE id = ?', 'superuser', first.principal.userId);

		expect(findByIdentity('discord', '1')?.role).toBe(DEFAULT_ROLE);
	});
});

describe('findByIdentity', () => {
	it('is null for an identity nobody holds', () => {
		expect(findByIdentity('discord', '404')).toBeNull();
	});

	it('finds the account that holds it', () => {
		const created = signedIn(DISCORD);

		expect(findByIdentity('discord', '1')?.userId).toBe(created.principal.userId);
	});
});

describe('linkIdentity', () => {
	it('adds another way to sign in', () => {
		const user = signedIn(DISCORD).principal.userId;

		expect(linkIdentity(user, { provider: 'google', providerUserId: '9' })).toBe(true);
	});

	it('makes the new identity resolve to the same account', () => {
		const user = signedIn(DISCORD).principal.userId;

		linkIdentity(user, { provider: 'google', providerUserId: '9' });

		expect(findByIdentity('google', '9')?.userId).toBe(user);
	});

	it('refuses an identity that already belongs to somebody else', () => {
		// Reassigning it is how one person takes over another's account.
		const first = signedIn(DISCORD).principal.userId;
		signedIn({ provider: 'google', providerUserId: '9' });

		expect(linkIdentity(first, { provider: 'google', providerUserId: '9' })).toBe(false);
	});

	it('leaves the other account holding it', () => {
		const first = signedIn(DISCORD).principal.userId;
		const second = signedIn({ provider: 'google', providerUserId: '9' }).principal.userId;

		linkIdentity(first, { provider: 'google', providerUserId: '9' });

		expect(findByIdentity('google', '9')?.userId).toBe(second);
	});

	it('refuses an identity this same user already has', () => {
		const user = signedIn(DISCORD).principal.userId;

		expect(linkIdentity(user, DISCORD)).toBe(false);
	});
});

describe('identitiesOf', () => {
	it('is empty for a user that does not exist', () => {
		expect(identitiesOf('nobody')).toStrictEqual([]);
	});

	it('lists every provider the user can sign in with', () => {
		const user = signedIn(DISCORD).principal.userId;
		linkIdentity(user, { provider: 'google', providerUserId: '9' });

		expect(
			identitiesOf(user)
				.map((row) => row.provider)
				.toSorted()
		).toStrictEqual(['discord', 'google']);
	});
});

describe('unlinkIdentity', () => {
	it('removes one of several', () => {
		const user = signedIn(DISCORD).principal.userId;
		linkIdentity(user, { provider: 'google', providerUserId: '9' });

		expect(unlinkIdentity(user, 'google')).toBe(true);
		expect(identitiesOf(user)).toHaveLength(1);
	});

	it('refuses the last one', () => {
		// Removing it would leave an account nobody can reach, which is a support request rather than
		// a thing to allow.
		const user = signedIn(DISCORD).principal.userId;

		expect(unlinkIdentity(user, 'discord')).toBe(false);
	});

	it('keeps the last one in the database', () => {
		const user = signedIn(DISCORD).principal.userId;

		unlinkIdentity(user, 'discord');

		expect(identitiesOf(user)).toHaveLength(1);
	});

	it('is false for a provider the user never had', () => {
		const user = signedIn(DISCORD).principal.userId;
		linkIdentity(user, { provider: 'google', providerUserId: '9' });

		expect(unlinkIdentity(user, 'twitch')).toBe(false);
	});

	it('does not touch another user holding the same provider', () => {
		const first = signedIn(DISCORD).principal.userId;
		linkIdentity(first, { provider: 'google', providerUserId: '9' });
		signedIn({ provider: 'discord', providerUserId: '2' });

		unlinkIdentity(first, 'discord');

		expect(findByIdentity('discord', '2')).not.toBeNull();
	});
});

describe('the schema the tests run against', () => {
	it('has a table for everything Drizzle declares', async () => {
		// The in-memory DDL is a second copy of `db/schema.ts`. This is the cheap half of the drift
		// check: a table added there and not there fails here rather than in whichever suite happened
		// to query it first.
		const { drizzleTables } = await import('./fixtures/memory-db.js');

		const present = database
			.rows(`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.map((row) => String(row.name))
			.toSorted();

		expect(present).toStrictEqual(drizzleTables());
	});
});

/**
 * The role floor: the environment naming who must be able to administer this install.
 *
 * It only ever raises. An owner named as an admin in the environment keeps the wider role, because
 * the setting exists to let somebody *in*, not to cap what they hold — and a setting that quietly
 * demoted the owner of a site would be very hard to diagnose from the outside.
 */
describe('the role floor', () => {
	it('gives a new account the floor instead of the default', () => {
		signedIn(DISCORD);

		const second = signIn(
			{ provider: 'discord', providerUserId: '2' },
			{ register: true },
			{
				floor: 'admin'
			}
		);

		expect(second).toMatchObject({ ok: true, principal: { role: 'admin' } });
	});

	it('still makes the first account the owner, not the floor', () => {
		const first = signIn(DISCORD, { register: true }, { floor: 'admin' });

		expect(first).toMatchObject({ ok: true, principal: { role: 'owner' } });
	});

	it('raises a returning account that ended up lower', () => {
		// The escape hatch: a creator who demoted themselves can still get back into their own site.
		signedIn(DISCORD);
		const second = signedIn({ provider: 'discord', providerUserId: '2' });

		expect(second.principal.role).toBe(DEFAULT_ROLE);

		const again = signIn(
			{ provider: 'discord', providerUserId: '2' },
			{ register: false },
			{
				floor: 'admin'
			}
		);

		expect(again).toMatchObject({ ok: true, principal: { role: 'admin' } });
	});

	it('persists the raise rather than only reporting it', () => {
		signedIn(DISCORD);
		signedIn({ provider: 'discord', providerUserId: '2' });

		signIn({ provider: 'discord', providerUserId: '2' }, { register: false }, { floor: 'admin' });

		expect(findByIdentity('discord', '2')?.role).toBe('admin');
	});

	it('never lowers anybody', () => {
		const owner = signedIn(DISCORD);

		const again = signIn(DISCORD, { register: false }, { floor: 'admin' });

		expect(again).toMatchObject({ ok: true, principal: { role: 'owner' } });
		expect(findByIdentity('discord', '1')?.role).toBe(owner.principal.role);
	});

	it('writes nothing when the role already satisfies the floor', () => {
		signedIn(DISCORD);

		signIn(DISCORD, { register: false }, { floor: 'admin' });

		expect(findByIdentity('discord', '1')?.role).toBe('owner');
	});

	it('does nothing at all without one', () => {
		signedIn(DISCORD);
		const second = signedIn({ provider: 'discord', providerUserId: '2' });

		expect(second.principal.role).toBe(DEFAULT_ROLE);
	});

	it('does not raise somebody the policy refused', () => {
		// The floor says what a role must be, not who may have an account.
		signedIn(DISCORD);

		const refused = signIn(
			{ provider: 'discord', providerUserId: '3' },
			{ register: false },
			{
				floor: 'admin'
			}
		);

		expect(refused).toStrictEqual({ ok: false, reason: 'registration_closed' });
	});
});

describe('people', () => {
	it('is empty on a fresh install', () => {
		expect(people()).toStrictEqual([]);
	});

	it('lists everybody', () => {
		signedIn(DISCORD);
		signedIn({ provider: 'discord', providerUserId: '2', name: 'Another' });

		expect(people().map((person) => person.name)).toStrictEqual(['Someone', 'Another']);
	});

	it('carries the role, checked', () => {
		const owner = signedIn(DISCORD);
		database.exec('UPDATE users SET role = ? WHERE id = ?', 'superuser', owner.principal.userId);

		expect(people()[0]?.role).toBe(DEFAULT_ROLE);
	});

	it('lists each person’s providers', () => {
		const user = signedIn(DISCORD).principal.userId;
		linkIdentity(user, { provider: 'google', providerUserId: '9' });

		expect(people()[0]?.providers).toStrictEqual(['discord', 'google']);
	});

	it('gives somebody with no identities an empty list rather than undefined', () => {
		// Not reachable through `signIn`, which creates both rows in one transaction — but a hand-edited
		// database should not take the page down.
		signedIn(DISCORD);
		database.exec('DELETE FROM identities');

		expect(people()[0]?.providers).toStrictEqual([]);
	});

	it('reads every identity in one query rather than one per person', () => {
		// Twenty accounts should not be twenty-one round trips. Asserted by behaviour: every person
		// gets their own providers and nobody gets somebody else's.
		const first = signedIn(DISCORD).principal.userId;
		const second = signedIn({ provider: 'discord', providerUserId: '2' }).principal.userId;
		linkIdentity(second, { provider: 'google', providerUserId: '9' });

		const byId = new Map(people().map((person) => [person.userId, person.providers]));

		expect(byId.get(first)).toStrictEqual(['discord']);
		expect(byId.get(second)).toStrictEqual(['discord', 'google']);
	});
});

describe('setRole', () => {
	/** An owner and somebody else, which is the shape every one of these needs. */
	function twoPeople() {
		const owner = signedIn(DISCORD).principal;
		const other = signedIn({ provider: 'discord', providerUserId: '2' }).principal;

		return { owner, other };
	}

	it('changes somebody’s role', () => {
		const { owner, other } = twoPeople();

		expect(setRole(other.userId, 'editor', owner)).toBeNull();
		expect(findByIdentity('discord', '2')?.role).toBe('editor');
	});

	it('refuses a user who does not exist', () => {
		const { owner } = twoPeople();

		expect(setRole('nobody', 'editor', owner)).toBe('no_such_user');
	});

	it('refuses changing your own role', () => {
		// Not a permission rule — an owner may do anything — but the mistake it prevents is a one-click
		// irreversible self-demotion, and the owner is the one person nobody else can put back.
		const { owner } = twoPeople();

		expect(setRole(owner.userId, 'member', owner)).toBe('yourself');
	});

	it('writes nothing when it refuses your own role', () => {
		const { owner } = twoPeople();

		setRole(owner.userId, 'member', owner);

		expect(findByIdentity('discord', '1')?.role).toBe('owner');
	});

	it('refuses demoting the only owner', () => {
		// An install with no owner has nobody who can promote one, so the only way back is editing the
		// database by hand.
		const { owner, other } = twoPeople();

		expect(setRole(owner.userId, 'admin', other)).toBe('last_owner');
	});

	it('allows demoting an owner once there is another', () => {
		// Which is how ownership is transferred: promote first, then demote.
		const { owner, other } = twoPeople();

		expect(setRole(other.userId, 'owner', owner)).toBeNull();
		expect(setRole(owner.userId, 'admin', other)).toBeNull();
		expect(findByIdentity('discord', '1')?.role).toBe('admin');
	});

	it('allows an owner to stay an owner', () => {
		// Setting the role it already holds is not a demotion, so the last-owner rule must not catch it.
		const { owner, other } = twoPeople();

		expect(setRole(owner.userId, 'owner', other)).toBeNull();
	});

	it('promotes somebody to owner without refusing', () => {
		const { owner, other } = twoPeople();

		expect(setRole(other.userId, 'owner', owner)).toBeNull();
		expect(findByIdentity('discord', '2')?.role).toBe('owner');
	});
});
