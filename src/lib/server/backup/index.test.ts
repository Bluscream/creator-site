/**
 * Backing this install up, and putting it back.
 *
 * Two things here are worth more than the rest. The first is that a backup taken while a writer
 * holds the database **captures what is in the write-ahead log** — the documented trap, tested by
 * leaving a connection open with uncheckpointed writes rather than by trusting `VACUUM INTO` to do
 * what it says. The second is that every refusal is also an assertion that **nothing was replaced**:
 * a restore that rejects an archive and has already overwritten the configuration is worse than one
 * that never ran, and "it refused" is not the same claim as "it left things alone".
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A getter, not a value: every test needs the database somewhere different, and a plain mocked
// constant is fixed for the whole file. The importing module reads the binding inside its
// functions, so a getter is re-evaluated per call — which is also how `paths.ts` treats `DATA_DIR`,
// and for the same reason.
vi.mock('$app/env/private', () => ({
	get DATABASE_URL() {
		return process.env.TEST_DATABASE_URL ?? 'data/creator-site.db';
	}
}));

vi.mock('../log.js', () => ({
	log: () => ({
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined
	})
}));

const { writeArchive } = await import('./archive.js');
const {
	DATABASE_ENTRY,
	MANIFEST_ENTRY,
	RestoreRefusal,
	createBackup,
	inspectBackup,
	knownMigrations,
	restoreBackup
} = await import('./index.js');

type Problem = InstanceType<typeof RestoreRefusal>['problem'];

const PASSWORD = 'a password for the archive';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'creator-backup-'));

	vi.stubEnv('DATA_DIR', join(root, 'data'));
	vi.stubEnv('TEST_DATABASE_URL', join(root, 'data', 'creator-site.db'));

	await mkdir(join(root, 'data'), { recursive: true });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** Where the archive under test goes. */
function archive(name = 'backup.crsbak'): string {
	return join(root, name);
}

/** The install's database path, as the mocked environment reports it. */
function databasePath(): string {
	return join(root, 'data', 'creator-site.db');
}

/** A configuration document on disk, as `document.ts` would have written it. */
async function writeConfig(name: string, value: unknown): Promise<void> {
	await mkdir(join(root, 'data', 'config'), { recursive: true });
	await writeFile(join(root, 'data', 'config', name), `${JSON.stringify(value, null, '\t')}\n`);
}

/** A migrated database with one identity row, and the open handle, so a caller can leave it open. */
function openDatabase(path = databasePath()): Database.Database {
	const handle = new Database(path);

	handle.pragma('journal_mode = WAL');
	migrate(drizzle(handle), { migrationsFolder: 'drizzle' });

	return handle;
}

/** A user row, which is the simplest thing in the schema that survives a round trip. */
function addUser(handle: Database.Database, id: string): void {
	handle
		.prepare('insert into users (id, name, role, created_at) values (?, ?, ?, ?)')
		.run(id, `user ${id}`, 'admin', Math.floor(Date.now() / 1000));
}

/** Every user id in a database at `path`. */
function usersIn(path: string): readonly string[] {
	const handle = new Database(path, { readonly: true });

	try {
		return (handle.prepare('select id from users order by id').all() as { id: string }[]).map(
			(row) => row.id
		);
	} finally {
		handle.close();
	}
}

/** Whether a path is there, for assertions about what a restore moved. */
async function present(path: string): Promise<boolean> {
	try {
		await stat(path);

		return true;
	} catch {
		return false;
	}
}

/** The problem a restore refused with, or null when it did not refuse. */
async function refusalOf(path: string, password = PASSWORD): Promise<Problem | null> {
	try {
		await restoreBackup(path, password);

		return null;
	} catch (cause) {
		if (cause instanceof RestoreRefusal) return cause.problem;

		throw cause;
	}
}

/** An entry record, as the manifest wants it. */
function described(name: string, body: Buffer) {
	return { name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}

describe('taking a backup', () => {
	it('captures the database, the configuration, and a manifest describing both', async () => {
		const handle = openDatabase();

		addUser(handle, 'alice');
		handle.close();

		await writeConfig('site.json', { name: 'a site' });
		await writeConfig('feed.json', { limit: 20 });

		const manifest = await createBackup(archive(), PASSWORD);

		expect(manifest.entries.map((entry) => entry.name)).toStrictEqual([
			'database.sqlite',
			'config/feed.json',
			'config/site.json'
		]);
		expect(manifest.migrations.length).toBe((await knownMigrations()).length);
		expect(new Date(manifest.createdAt).getUTCFullYear()).toBeGreaterThan(2024);
	});

	it('captures writes still sitting in the write-ahead log', async () => {
		// The documented correctness trap, and the reason `VACUUM INTO` is here rather than a file
		// copy. The writer is deliberately left open and uncheckpointed: `tar`ing the `.db` file at
		// this moment produces an archive that restores cleanly and is missing this row.
		const handle = openDatabase();

		addUser(handle, 'in-the-wal');

		expect((await stat(`${databasePath()}-wal`)).size).toBeGreaterThan(0);

		await createBackup(archive(), PASSWORD);

		handle.close();
		await rm(join(root, 'data'), { recursive: true, force: true });
		await mkdir(join(root, 'data'), { recursive: true });
		await restoreBackup(archive(), PASSWORD);

		expect(usersIn(databasePath())).toStrictEqual(['in-the-wal']);
	});

	it('backs up an install that has never opened its database', async () => {
		// A fresh install, which is exactly when somebody is most likely to try this. Not an error:
		// there is configuration worth keeping and no database yet.
		await writeConfig('site.json', { name: 'brand new' });

		const manifest = await createBackup(archive(), PASSWORD);

		expect(manifest.entries.map((entry) => entry.name)).toStrictEqual(['config/site.json']);
		expect(manifest.migrations).toStrictEqual([]);
	});

	it('backs up an install with nothing in it at all', async () => {
		const manifest = await createBackup(archive(), PASSWORD);

		expect(manifest.entries).toStrictEqual([]);
	});

	it('leaves no scratch directory behind', async () => {
		openDatabase().close();
		await createBackup(archive(), PASSWORD);

		expect(await readdir(join(root, 'data', '.work'))).toStrictEqual([]);
	});

	it('records a digest that matches the bytes it wrote', async () => {
		await writeConfig('site.json', { name: 'a site' });

		const manifest = await createBackup(archive(), PASSWORD);
		const entry = manifest.entries[0];
		const onDisk = await readFile(join(root, 'data', 'config', 'site.json'));

		expect(entry?.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
		expect(entry?.bytes).toBe(onDisk.length);
	});

	it('does not disturb the database it read', async () => {
		// Read-only on purpose: taking a backup must never be the thing that breaks the install.
		const handle = openDatabase();

		addUser(handle, 'alice');

		await createBackup(archive(), PASSWORD);

		addUser(handle, 'bob');

		expect(usersIn(databasePath())).toStrictEqual(['alice', 'bob']);
		handle.close();
	});
});

describe('reading a backup without restoring it', () => {
	it('returns the manifest and touches nothing', async () => {
		await writeConfig('site.json', { name: 'original' });

		const written = await createBackup(archive(), PASSWORD);

		await writeConfig('site.json', { name: 'changed since' });

		const read = await inspectBackup(archive(), PASSWORD);

		expect(read).toStrictEqual(written);
		expect(JSON.parse(await readFile(join(root, 'data', 'config', 'site.json'), 'utf8'))).toEqual({
			name: 'changed since'
		});
	});
});

describe('restoring', () => {
	it('puts the database and the configuration back', async () => {
		const handle = openDatabase();

		addUser(handle, 'alice');
		handle.close();
		await writeConfig('site.json', { name: 'as backed up' });

		await createBackup(archive(), PASSWORD);

		// The install moves on, the way it would between a backup and the day it is needed.
		const later = openDatabase();

		addUser(later, 'bob');
		later.close();
		await writeConfig('site.json', { name: 'changed since' });

		const report = await restoreBackup(archive(), PASSWORD);

		expect(usersIn(databasePath())).toStrictEqual(['alice']);
		expect(JSON.parse(await readFile(join(root, 'data', 'config', 'site.json'), 'utf8'))).toEqual({
			name: 'as backed up'
		});
		expect(report.manifest.entries.length).toBe(2);
	});

	it('keeps what it replaced, rather than deleting it', async () => {
		const handle = openDatabase();

		addUser(handle, 'from the backup');
		handle.close();
		await createBackup(archive(), PASSWORD);

		const later = openDatabase();

		addUser(later, 'about to be replaced');
		later.close();

		await writeConfig('site.json', { name: 'about to be replaced' });

		const report = await restoreBackup(archive(), PASSWORD);

		// The whole point: a restore performed by mistake is recoverable. Both halves, because the
		// first version of this test checked only the database — and a build that kept the database
		// aside while deleting the configuration outright passed it.
		expect(usersIn(join(report.superseded, 'database.sqlite'))).toContain('about to be replaced');
		expect(
			JSON.parse(await readFile(join(report.superseded, 'config', 'site.json'), 'utf8'))
		).toEqual({ name: 'about to be replaced' });
	});

	it('moves the write-ahead log of the database it replaced out of the way', async () => {
		// A WAL left beside a replaced database is how a file opens and contains a mixture of two
		// installs — the restored pages plus whatever the old connection had logged but not
		// checkpointed.
		//
		// The connection is left **open** across the restore, which is what makes this test mean
		// anything. Its first version closed it first, and `close()` checkpoints: there was no WAL
		// on disk by the time the restore ran, so a build that ignored the sidecars entirely passed.
		const handle = openDatabase();

		addUser(handle, 'backed up');
		handle.exec('pragma wal_checkpoint(TRUNCATE)');
		await createBackup(archive(), PASSWORD);

		addUser(handle, 'logged, not checkpointed');

		expect((await stat(`${databasePath()}-wal`)).size).toBeGreaterThan(0);

		const report = await restoreBackup(archive(), PASSWORD);

		handle.close();

		// Asserted on the filesystem, because that is what this code does: nothing of the old
		// database may be left beside the restored one under a name SQLite would pick up.
		for (const suffix of ['-wal', '-shm']) {
			expect(await present(`${databasePath()}${suffix}`)).toBe(false);
		}

		expect(await present(join(report.superseded, 'database.sqlite-wal'))).toBe(true);
		expect(usersIn(databasePath())).toStrictEqual(['backed up']);
	});

	it('accepts a backup with fewer migrations than this build ships', async () => {
		// The direction that has to work, because it is the one a restore is usually for: an old
		// archive, rolled forward by the migrator on the next open.
		const handle = openDatabase();

		addUser(handle, 'alice');
		handle.exec(
			'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)'
		);
		handle.close();

		await createBackup(archive(), PASSWORD);

		expect(await refusalOf(archive())).toBeNull();
	});

	it('refuses a backup whose database has a schema change this build does not know', async () => {
		const handle = openDatabase();

		handle
			.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
			.run('from the future', 9_999_999_999_999);
		handle.close();

		await createBackup(archive(), PASSWORD);

		expect(await refusalOf(archive())).toBe('from_a_newer_build');
	});
});

describe('an archive this restore refuses, without having changed anything', () => {
	/** The install's state before a refused restore, so a case can assert it is still that. */
	async function existing(): Promise<{ users: readonly string[]; site: string }> {
		return {
			users: usersIn(databasePath()),
			site: await readFile(join(root, 'data', 'config', 'site.json'), 'utf8')
		};
	}

	beforeEach(async () => {
		const handle = openDatabase();

		addUser(handle, 'must survive');
		handle.close();
		await writeConfig('site.json', { name: 'must survive' });
	});

	/** Builds an archive out of exactly the entries given, bypassing `createBackup`. */
	async function crafted(entries: readonly { name: string; body: Buffer }[]): Promise<string> {
		await writeArchive(archive('crafted.crsbak'), PASSWORD, entries);

		return archive('crafted.crsbak');
	}

	it.each([
		[
			'no manifest',
			async () => crafted([{ name: 'config/site.json', body: Buffer.from('{}') }]),
			'manifest_missing'
		],
		[
			'a manifest that is not JSON',
			async () => crafted([{ name: MANIFEST_ENTRY, body: Buffer.from('not json at all') }]),
			'manifest_invalid'
		],
		[
			'a manifest with a field this build does not know',
			async () =>
				crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 1,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: [],
								// Strict on purpose: an unknown field means the writer knew about
								// something this build would silently drop.
								uploads: ['a-file.png']
							})
						)
					}
				]),
			'manifest_invalid'
		],
		[
			'a manifest from a newer manifest format',
			async () =>
				crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 99,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: []
							})
						)
					}
				]),
			'manifest_invalid'
		],
		[
			'an entry nothing here would have written',
			async () =>
				crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 1,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: []
							})
						)
					},
					{ name: 'config/evil.sh', body: Buffer.from('#!/bin/sh') }
				]),
			'unexpected_entry'
		],
		[
			'a member whose bytes are not what the manifest describes',
			async () => {
				const body = Buffer.from('{"name":"something else"}');

				return crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 1,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: [
									described('config/site.json', Buffer.from('{"name":"what was promised"}'))
								]
							})
						)
					},
					{ name: 'config/site.json', body }
				]);
			},
			'contents_do_not_match_manifest'
		],
		[
			'a manifest listing a member the archive does not contain',
			async () =>
				crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 1,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: [described('config/missing.json', Buffer.from('{}'))]
							})
						)
					}
				]),
			'contents_do_not_match_manifest'
		],
		[
			'a database that is not a database',
			async () => {
				const body = Buffer.from('this is definitely not SQLite');

				return crafted([
					{
						name: MANIFEST_ENTRY,
						body: Buffer.from(
							JSON.stringify({
								format: 1,
								createdAt: new Date().toISOString(),
								migrations: [],
								entries: [described(DATABASE_ENTRY, body)]
							})
						)
					},
					{ name: DATABASE_ENTRY, body }
				]);
			},
			'not_a_database'
		]
	])('refuses %s', async (_what, build, problem) => {
		const before = await existing();
		const path = await build();

		expect(await refusalOf(path)).toBe(problem);

		// The claim that matters. "It refused" and "it left the install alone" are different
		// statements, and only the second one is what an operator is relying on.
		expect(usersIn(databasePath())).toStrictEqual(before.users);
		expect(await readFile(join(root, 'data', 'config', 'site.json'), 'utf8')).toBe(before.site);
	});

	it('refuses a SQLite file that opens and is damaged inside', async () => {
		// `integrity_check` rather than trusting the open. SQLite opens a file with an intact header
		// and a shredded middle quite happily, and complains on the first query that needs the
		// damaged page — which, without this, would be after the restore had replaced everything.
		//
		// The damage is at the *end* of the file, and this is the whole point of the case. The first
		// version of this test shredded bytes 8192 onwards, which is where `__drizzle_migrations`
		// lives, so reading the migration history threw and the refusal came from there. It passed
		// with the integrity check deleted — it was testing the wrong thing. Corrupting pages that
		// only the `users` table occupies leaves every query this code makes working perfectly.
		const handle = openDatabase(join(root, 'donor.db'));

		for (let index = 0; index < 2000; index += 1) addUser(handle, `user-${String(index)}`);

		handle.exec('pragma wal_checkpoint(TRUNCATE)');
		handle.close();

		const bytes = await readFile(join(root, 'donor.db'));

		bytes.fill(0x7a, bytes.length - 8192, bytes.length - 100);

		const before = await existing();
		const path = await crafted([
			{
				name: MANIFEST_ENTRY,
				body: Buffer.from(
					JSON.stringify({
						format: 1,
						createdAt: new Date().toISOString(),
						migrations: [],
						entries: [described(DATABASE_ENTRY, bytes)]
					})
				)
			},
			{ name: DATABASE_ENTRY, body: bytes }
		]);

		expect(await refusalOf(path)).toBe('not_a_database');
		expect(usersIn(databasePath())).toStrictEqual(before.users);
	});

	it('refuses a database with no migration history at all', async () => {
		const handle = new Database(join(root, 'foreign.db'));

		handle.exec('create table something_else (x)');
		handle.close();

		const bytes = await readFile(join(root, 'foreign.db'));
		const path = await crafted([
			{
				name: MANIFEST_ENTRY,
				body: Buffer.from(
					JSON.stringify({
						format: 1,
						createdAt: new Date().toISOString(),
						migrations: [],
						entries: [described(DATABASE_ENTRY, bytes)]
					})
				)
			},
			{ name: DATABASE_ENTRY, body: bytes }
		]);

		expect(await refusalOf(path)).toBe('not_a_database');
	});

	it('refuses the wrong password without touching anything', async () => {
		const before = await existing();

		await createBackup(archive(), PASSWORD);

		await expect(restoreBackup(archive(), 'the wrong password')).rejects.toThrow(
			/password is wrong or the file is damaged/
		);

		expect(usersIn(databasePath())).toStrictEqual(before.users);
	});
});
