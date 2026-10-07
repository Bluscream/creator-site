/**
 * Linked accounts: stored, read back, and never leaking a token where one should not be.
 *
 * Against a real in-memory SQLite and the real `secrets.ts`, because the two properties worth most
 * here are a database behaviour and a crypto behaviour: the unique index on
 * `(platform, platform_account_id)` is what stops two rows disagreeing about which credential is
 * current, and the token in the column has to be unreadable without the key.
 *
 * The test that matters most is the dull one: that {@link Connection} — the shape a page sees —
 * contains no token. That split exists to make a `load` function serialising a credential into a
 * page's props *impossible* rather than discouraged, and nothing but a test keeps it true.
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

/** `SECRET_KEY`, which a few of these change to simulate a key that was rotated or never set. */
const env = vi.hoisted(() => {
	const state: { key: string | undefined } = { key: 'a-test-passphrase-at-least-16' };

	return state;
});

vi.mock('$app/env/private', () => ({
	get SECRET_KEY() {
		return env.key;
	}
}));

const {
	connectionFor,
	connectionsOf,
	credentialFor,
	link,
	refreshCredential,
	setShown,
	shownConnections,
	unlink
} = await import('./connections.js');

const { forgetKey } = await import('./secrets.js');
const { signIn } = await import('./accounts.js');

/** The key a test runs under unless it is about not having one. */
const KEY = 'a-test-passphrase-at-least-16';

let database: OpenMemoryDb;

/** A user to hang connections off. */
let user: string;

/** Somebody else, for the tests about one person not reaching another's rows. */
let other: string;

function withKey(value: string | undefined): void {
	env.key = value;
	forgetKey();
}

/** A linked Twitch account, as a caller supplies one. */
function twitch(overrides: Partial<Parameters<typeof link>[0]> = {}) {
	return {
		userId: user,
		platform: 'twitch',
		platformAccountId: '12345',
		handle: 'somebody',
		method: 'oauth' as const,
		accessToken: 'an-access-token',
		refreshToken: 'a-refresh-token',
		scopes: ['user:read:email', 'channel:read:subscriptions'],
		...overrides
	};
}

/** Links and returns the connection, failing the test if it was refused. */
function linked(input: Parameters<typeof link>[0] = twitch()) {
	const result = link(input);

	if (typeof result === 'string') throw new Error(`link refused: ${result}`);

	return result;
}

beforeEach(() => {
	database = memoryDb();
	open.current = { db: database.db };
	logged.errors.length = 0;
	withKey(KEY);

	const first = signIn(
		{ provider: 'discord', providerUserId: '1', name: 'Someone' },
		{
			register: true
		}
	);
	const second = signIn(
		{ provider: 'discord', providerUserId: '2', name: 'Another' },
		{
			register: true
		}
	);

	if (!first.ok || !second.ok) throw new Error('could not create the test users');

	user = first.principal.userId;
	other = second.principal.userId;
});

afterEach(() => {
	open.current = null;
	database.close();
});

describe('link', () => {
	it('stores a connection', () => {
		expect(linked().platform).toBe('twitch');
	});

	it('keeps the platform account id, which is what identifies the account', () => {
		expect(linked().platformAccountId).toBe('12345');
	});

	it('keeps the granted scopes as a list', () => {
		expect(linked().scopes).toStrictEqual(['user:read:email', 'channel:read:subscriptions']);
	});

	it('has no scopes when the platform granted none', () => {
		// Empty rather than `['']`, which is what a naive split of an empty column gives.
		expect(linked(twitch({ scopes: [] })).scopes).toStrictEqual([]);
	});

	it('is not shown publicly until somebody says so', () => {
		// Showing an account on the public page is a decision, not a side effect of linking it.
		expect(linked().shown).toBe(false);
	});

	it('reports that it can be refreshed', () => {
		expect(linked().refreshable).toBe(true);
	});

	it('reports that it cannot, when no refresh token came back', () => {
		expect(linked(twitch({ refreshToken: null })).refreshable).toBe(false);
	});

	it('writes exactly one row', () => {
		linked();

		expect(database.rows('SELECT id FROM connections')).toHaveLength(1);
	});

	it('replaces the same account rather than adding a second row', () => {
		// Re-linking is how somebody fixes an expired token or grants a scope they declined. Making
		// them remove the old row first would be a step with no purpose.
		linked();
		linked(twitch({ accessToken: 'a-newer-token' }));

		expect(database.rows('SELECT id FROM connections')).toHaveLength(1);
	});

	it('replaces the stored credential when it does', () => {
		linked();
		linked(twitch({ accessToken: 'a-newer-token' }));

		expect(credentialFor('twitch')?.accessToken).toBe('a-newer-token');
	});

	it('keeps whether the account is shown across a re-link', () => {
		// Re-linking to fix a token must not silently un-publish a social the creator chose to show.
		const connection = linked();
		setShown(user, connection.id, true);

		linked(twitch({ accessToken: 'a-newer-token' }));

		expect(connectionFor('twitch')?.shown).toBe(true);
	});

	it('refuses an account another user already holds', () => {
		// Moving it is how one person takes over another's integration.
		linked();

		expect(link(twitch({ userId: other }))).toBe('already_linked');
	});

	it('leaves the other user holding it', () => {
		linked();
		link(twitch({ userId: other }));

		expect(connectionFor('twitch')?.userId).toBe(user);
	});

	it('allows the same person to link two accounts on one platform', () => {
		linked();
		linked(twitch({ platformAccountId: '67890', handle: 'another' }));

		expect(connectionsOf(user)).toHaveLength(2);
	});

	it('allows the same account id on a different platform', () => {
		linked();
		linked(twitch({ platform: 'kick' }));

		expect(connectionsOf(user)).toHaveLength(2);
	});

	it('stores a link that carries no secret at all', () => {
		// A platform whose reads need no credential. Nothing to encrypt, so no key is required.
		withKey(undefined);

		const connection = link({
			userId: user,
			platform: 'bluesky',
			platformAccountId: 'did:plc:abc',
			handle: 'name.bsky.social',
			method: 'oauth'
		});

		expect(connection).toMatchObject({ platform: 'bluesky' });
	});
});

describe('what the database actually holds', () => {
	it('does not hold the access token', () => {
		// A SQLite file ends up in backups, snapshots and the copy somebody made before an upgrade.
		linked();

		expect(JSON.stringify(database.rows('SELECT * FROM connections'))).not.toContain(
			'an-access-token'
		);
	});

	it('does not hold the refresh token', () => {
		linked();

		expect(JSON.stringify(database.rows('SELECT * FROM connections'))).not.toContain(
			'a-refresh-token'
		);
	});

	it('holds something in the token column rather than nothing', () => {
		// The inverse mistake: a store that "encrypts" by dropping the value would pass the two above.
		linked();

		expect(database.rows('SELECT access_token FROM connections')[0]?.access_token).toBeTruthy();
	});

	it('stores a different ciphertext for the same token twice', () => {
		linked();
		const first = database.rows('SELECT access_token FROM connections')[0]?.access_token;

		linked(twitch({ platformAccountId: '67890' }));
		const second = database.rows(
			"SELECT access_token FROM connections WHERE platform_account_id = '67890'"
		)[0]?.access_token;

		expect(first).not.toBe(second);
	});
});

describe('Connection, which is what a page sees', () => {
	it('carries no access token', () => {
		// The whole reason for two shapes: a `load` function cannot serialise what it was never given.
		expect('accessToken' in linked()).toBe(false);
	});

	it('carries no refresh token', () => {
		expect('refreshToken' in linked()).toBe(false);
	});

	it('carries no token under any key', () => {
		const serialised = JSON.stringify(linked());

		expect(serialised).not.toContain('an-access-token');
		expect(serialised).not.toContain('a-refresh-token');
	});

	it('still says whether a refresh is possible', () => {
		// Which is the useful half of knowing there is a refresh token.
		expect(linked().refreshable).toBe(true);
	});

	it('reports a method that does not exist as the least capable one', () => {
		const connection = linked();
		database.exec('UPDATE connections SET method = ? WHERE id = ?', 'magic', connection.id);

		expect(connectionFor('twitch')?.method).toBe('token');
	});

	it('says so in the log when it does', () => {
		const connection = linked();
		database.exec('UPDATE connections SET method = ? WHERE id = ?', 'magic', connection.id);
		connectionFor('twitch');

		expect(logged.errors).toHaveLength(1);
		expect(logged.errors[0]).toMatch(/link method/);
	});
});

describe('expiry', () => {
	it('is not expired without an expiry', () => {
		expect(linked(twitch({ expiresAt: null })).expired).toBe(false);
	});

	it('is not expired well before it expires', () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 3600;

		expect(linked(twitch({ expiresAt })).expired).toBe(false);
	});

	it('is expired after it expires', () => {
		const expiresAt = Math.floor(Date.now() / 1000) - 1;

		expect(linked(twitch({ expiresAt })).expired).toBe(true);
	});

	it('is expired just before it expires', () => {
		// A token that expires in four seconds will expire mid-request. Treating it as already gone
		// means the refresh happens before the call rather than as a retry after a 401.
		const expiresAt = Math.floor(Date.now() / 1000) + 5;

		expect(linked(twitch({ expiresAt })).expired).toBe(true);
	});
});

describe('credentialFor', () => {
	it('is null for a platform nothing is linked for', () => {
		expect(credentialFor('kick')).toBeNull();
	});

	it('hands back the access token', () => {
		linked();

		expect(credentialFor('twitch')?.accessToken).toBe('an-access-token');
	});

	it('hands back the refresh token', () => {
		linked();

		expect(credentialFor('twitch')?.refreshToken).toBe('a-refresh-token');
	});

	it('hands back null for a token that was never stored', () => {
		linked(twitch({ refreshToken: null }));

		expect(credentialFor('twitch')?.refreshToken).toBeNull();
	});

	it('carries the handle, so a provider needs no second query', () => {
		linked();

		expect(credentialFor('twitch')?.handle).toBe('somebody');
	});

	it('is null once the key has changed, rather than throwing', () => {
		// What a rotated `SECRET_KEY` looks like. A provider cannot act on the difference between
		// "nothing linked" and "cannot be read", and the alternative is every provider catching this.
		linked();

		withKey('a-completely-different-passphrase');

		expect(credentialFor('twitch')).toBeNull();
	});

	it('says so in the log when it is', () => {
		// Which is where it is actually diagnosable. Asserted on the *text*, not just on the count: a
		// log line that says nothing is the same as no log line to whoever has to read it, and counting
		// lines would pass with an empty message. (Found by planting exactly that.)
		linked();
		withKey('a-completely-different-passphrase');
		credentialFor('twitch');

		expect(logged.errors).toHaveLength(1);
		expect(logged.errors[0]).toMatch(/linked again/);
	});

	it('never logs the token or the ciphertext', () => {
		linked();
		const ciphertext = String(
			database.rows('SELECT access_token FROM connections')[0]?.access_token
		);

		withKey('a-completely-different-passphrase');
		credentialFor('twitch');

		expect(logged.errors.join(' ')).not.toContain(ciphertext);
	});

	it('prefers the most recently linked account for a platform', () => {
		// A single-tenant site has one account per platform in practice, and "the newest" is what a
		// creator fixing a broken token expects.
		linked(twitch({ platformAccountId: '1', accessToken: 'older' }));
		database.exec('UPDATE connections SET created_at = ? WHERE platform_account_id = ?', '1', '1');
		linked(twitch({ platformAccountId: '2', accessToken: 'newer' }));

		expect(credentialFor('twitch')?.accessToken).toBe('newer');
	});
});

describe('refreshCredential', () => {
	it('replaces the access token', () => {
		const connection = linked();

		expect(refreshCredential(connection.id, { accessToken: 'a-fresh-token' })).toBe(true);
		expect(credentialFor('twitch')?.accessToken).toBe('a-fresh-token');
	});

	it('keeps the stored refresh token when the platform sent no new one', () => {
		// A platform that rotates its refresh token sends one; one that does not sends nothing, and
		// clearing the stored one would make the next refresh impossible.
		const connection = linked();

		refreshCredential(connection.id, { accessToken: 'a-fresh-token' });

		expect(credentialFor('twitch')?.refreshToken).toBe('a-refresh-token');
	});

	it('replaces the refresh token when the platform rotated it', () => {
		const connection = linked();

		refreshCredential(connection.id, {
			accessToken: 'a-fresh-token',
			refreshToken: 'a-rotated-refresh-token'
		});

		expect(credentialFor('twitch')?.refreshToken).toBe('a-rotated-refresh-token');
	});

	it('leaves the handle alone', () => {
		// A refresh changes only the credential. A full link would overwrite the handle with whatever
		// the caller happened to have, which on a refresh endpoint is nothing.
		const connection = linked();

		refreshCredential(connection.id, { accessToken: 'a-fresh-token' });

		expect(connectionFor('twitch')?.handle).toBe('somebody');
	});

	it('leaves whether the account is shown alone', () => {
		const connection = linked();
		setShown(user, connection.id, true);

		refreshCredential(connection.id, { accessToken: 'a-fresh-token' });

		expect(connectionFor('twitch')?.shown).toBe(true);
	});

	it('records the new expiry', () => {
		const connection = linked();
		const expiresAt = Math.floor(Date.now() / 1000) + 7200;

		refreshCredential(connection.id, { accessToken: 'a-fresh-token', expiresAt });

		expect(connectionFor('twitch')?.expiresAt).toBe(expiresAt);
	});

	it('is false for a connection that does not exist', () => {
		expect(refreshCredential('nobody', { accessToken: 'x' })).toBe(false);
	});

	it('is false with no key rather than storing plaintext', () => {
		const connection = linked();
		withKey(undefined);

		expect(refreshCredential(connection.id, { accessToken: 'a-fresh-token' })).toBe(false);
	});
});

describe('link, without a key', () => {
	it('refuses rather than storing a token in the clear', () => {
		// A database of plaintext credentials is not something a later fix can undo.
		withKey(undefined);

		expect(link(twitch())).toBe('no_secret_key');
	});

	it('writes nothing when it refuses', () => {
		withKey(undefined);
		link(twitch());

		expect(database.rows('SELECT id FROM connections')).toStrictEqual([]);
	});
});

describe('connectionsOf', () => {
	it('is empty for somebody with none', () => {
		expect(connectionsOf(user)).toStrictEqual([]);
	});

	it('lists what a person linked', () => {
		linked();

		expect(connectionsOf(user).map((connection) => connection.platform)).toStrictEqual(['twitch']);
	});

	it('leaves out somebody else’s', () => {
		linked();

		expect(connectionsOf(other)).toStrictEqual([]);
	});
});

describe('shownConnections', () => {
	it('is empty until something is shown', () => {
		linked();

		expect(shownConnections()).toStrictEqual([]);
	});

	it('lists what was shown', () => {
		const connection = linked();
		setShown(user, connection.id, true);

		expect(shownConnections().map((entry) => entry.platform)).toStrictEqual(['twitch']);
	});

	it('leaves out what was hidden again', () => {
		const connection = linked();
		setShown(user, connection.id, true);
		setShown(user, connection.id, false);

		expect(shownConnections()).toStrictEqual([]);
	});

	it('carries no token, because the public page renders this', () => {
		const connection = linked();
		setShown(user, connection.id, true);

		expect(JSON.stringify(shownConnections())).not.toContain('an-access-token');
	});
});

describe('setShown', () => {
	it('refuses somebody else’s connection', () => {
		// The id arrives from a form, which means from outside the trust boundary whatever the page
		// believes it rendered.
		const connection = linked();

		expect(setShown(other, connection.id, true)).toBe(false);
		expect(connectionFor('twitch')?.shown).toBe(false);
	});

	it('is false for a connection that does not exist', () => {
		expect(setShown(user, 'nobody', true)).toBe(false);
	});
});

describe('unlink', () => {
	it('removes the connection', () => {
		const connection = linked();

		expect(unlink(user, connection.id)).toBe(true);
		expect(connectionFor('twitch')).toBeNull();
	});

	it('refuses somebody else’s', () => {
		const connection = linked();

		expect(unlink(other, connection.id)).toBe(false);
		expect(connectionFor('twitch')).not.toBeNull();
	});

	it('is false for a connection that does not exist', () => {
		expect(unlink(user, 'nobody')).toBe(false);
	});

	it('takes the credential with it', () => {
		const connection = linked();
		unlink(user, connection.id);

		expect(credentialFor('twitch')).toBeNull();
	});
});

describe('when a user is deleted', () => {
	it('their connections go too', () => {
		// `onDelete: 'cascade'`, which is only enforced because the fixture turns foreign keys on — the
		// same pragma production sets.
		linked();

		database.exec('DELETE FROM users WHERE id = ?', user);

		expect(database.rows('SELECT id FROM connections')).toStrictEqual([]);
	});
});
