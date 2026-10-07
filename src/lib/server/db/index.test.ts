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

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';

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
