/**
 * That the native database binding actually loads and works.
 *
 * ### Why this test exists, when the rest of the suite is pure functions
 *
 * `better-sqlite3` is a compiled C++ addon. Every other dependency in this project is JavaScript
 * that either imports or does not; this one can install successfully, type-check successfully, pass
 * every other test, and then throw at the first `new Database()` on the deployment platform because
 * the `.node` file for that platform is missing or was built against a different ABI.
 *
 * The container depends on this directly. `Dockerfile` installs production dependencies with
 * `--ignore-scripts`, which skips `node-gyp rebuild` and uses the prebuilt binding shipped in the
 * package — currently `prebuilds/linuxmusl-x64.node` for Alpine on x64. That decision removed a
 * measured 308 MB of compiler toolchain from the image, and it is only safe while a usable prebuild
 * exists. If a future version of the package drops one, or renames the platform triple, or needs an
 * ABI the pinned Node does not provide, this test fails — rather than the first request that
 * touches the database, in production, on someone else's server.
 *
 * ### Why `:memory:` and not {@link db}
 *
 * {@link db} reads `DATABASE_URL` and opens that path. Calling it here would make running the test
 * suite create the real database file as a side effect, which is the exact behaviour the lazy
 * connection in `./index.ts` was written to avoid. The binding is the same binding either way, so
 * this opens its own throwaway database and leaves the configured one alone.
 *
 * Drizzle is in the round trip rather than `better-sqlite3` alone because the pairing is what
 * production uses: the driver can load fine and still be incompatible with the version of Drizzle
 * wrapping it.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PRAGMAS } from './index.js';

/**
 * A table that exists only here.
 *
 * `./schema.ts` is deliberately empty until the first feature needs a table, so this test declares
 * its own rather than waiting for one — the binding is worth checking now, and a test that depends
 * on the schema would start failing for reasons that have nothing to do with the binding.
 */
const probe = sqliteTable('probe', {
	id: int('id').primaryKey({ autoIncrement: true }),
	label: text('label').notNull()
});

let handle: Database.Database | null = null;

/** Opens a throwaway database with {@link probe} created in it. */
function openProbeDb(): ReturnType<typeof drizzle> {
	handle = new Database(':memory:');

	const database = drizzle(handle);

	database.run(sql`create table probe (id integer primary key autoincrement, label text not null)`);

	return database;
}

afterEach(() => {
	handle?.close();
	handle = null;
});

describe('the better-sqlite3 native binding', () => {
	it('loads and reports a SQLite version', () => {
		const database = openProbeDb();

		const [row] = database.all<{ version: string }>(sql`select sqlite_version() as version`);

		// Any version is fine; the point is that the addon loaded and executed C code at all. The
		// shape check is what distinguishes "it ran" from "it returned something odd".
		expect(row?.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('writes and reads a row back through Drizzle', () => {
		const database = openProbeDb();

		database.insert(probe).values({ label: 'written' }).run();

		expect(database.select().from(probe).all()).toStrictEqual([{ id: 1, label: 'written' }]);
	});

	it('enforces a constraint, so it is a real database and not a stub', () => {
		const database = openProbeDb();

		database.insert(probe).values({ id: 1, label: 'first' }).run();

		// A second row with the same primary key. If this *succeeds*, whatever answered the earlier
		// assertions was not SQLite.
		expect(() => database.insert(probe).values({ id: 1, label: 'again' }).run()).toThrow(
			/UNIQUE constraint failed/
		);
	});
});

/**
 * That the connection settings in {@link PRAGMAS} are the ones that matter, and that they take.
 *
 * SQLite applies pragmas per connection and silently ignores one it does not understand — a
 * misspelling, or a build without the feature. `foreign_keys` is the dangerous one: it defaults to
 * *off*, so without it `onDelete: 'cascade'` does nothing at all and deleting a user leaves their
 * sessions behind, resolvable until they expire. Nothing reports that; it just quietly is not true.
 *
 * Applied to a throwaway database rather than through `db()`, for the reason given at the top: a
 * test must not create the configured database file as a side effect.
 */
describe('the connection pragmas', () => {
	/** A throwaway database with {@link PRAGMAS} applied, as `db()` applies them. */
	function openConfigured(): Database.Database {
		handle = new Database(':memory:');

		for (const pragma of PRAGMAS) handle.pragma(pragma);

		return handle;
	}

	it('enables foreign keys, which SQLite does not do by default', () => {
		expect(openConfigured().pragma('foreign_keys', { simple: true })).toBe(1);
	});

	it('actually cascades a delete once they are on', () => {
		// The assertion the rest of the schema depends on. Checking the pragma reads back as 1 says the
		// setting took; this says the setting does what it is there for.
		const database = openConfigured();

		database.exec('create table parent (id text primary key not null)');
		database.exec(
			'create table child (id text primary key not null, parent text not null references parent(id) on delete cascade)'
		);
		database.prepare('insert into parent (id) values (?)').run('p');
		database.prepare('insert into child (id, parent) values (?, ?)').run('c', 'p');

		database.prepare('delete from parent where id = ?').run('p');

		expect(database.prepare('select id from child').all()).toStrictEqual([]);
	});

	it('rejects a reference to a row that does not exist', () => {
		const database = openConfigured();

		database.exec('create table parent (id text primary key not null)');
		database.exec(
			'create table child (id text primary key not null, parent text not null references parent(id))'
		);

		expect(() =>
			database.prepare('insert into child (id, parent) values (?, ?)').run('c', 'missing')
		).toThrow(/FOREIGN KEY constraint failed/);
	});

	it('puts the journal in WAL mode, so a reader and a writer do not block each other', () => {
		// A request that renews a session is a writer, and in the default rollback journal it would
		// block every concurrent read of the same file.
		//
		// On a file rather than `:memory:`, which reports `memory` and cannot be WAL at all — so this
		// is the one pragma that has to be checked against something resembling the real deployment.
		const path = join(mkdtempSync(join(tmpdir(), 'creator-site-db-')), 'probe.db');

		handle = new Database(path);

		for (const pragma of PRAGMAS) handle.pragma(pragma);

		expect(handle.pragma('journal_mode', { simple: true })).toBe('wal');
	});

	it('waits for a busy database rather than throwing at whoever was second', () => {
		expect(openConfigured().pragma('busy_timeout', { simple: true })).toBe(5000);
	});
});
