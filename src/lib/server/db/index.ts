/**
 * The database connection.
 *
 * SQLite through Drizzle and `better-sqlite3`: one file, no operations, which is the right shape
 * for a self-hosted single-tenant product. Drizzle's schema is TypeScript, so the tables live in
 * the same typed world as the environment and the domain types rather than in a `.sql` file nothing
 * checks.
 *
 * ### Opened lazily, which is not what the scaffold did
 *
 * The scaffold connected at module load. That means importing this module anywhere — including
 * transitively, including from a test — creates the database file as a side effect of an `import`.
 * Here the connection is made on first use and reused after, so a module that imports `db` and
 * never calls it costs nothing, and a test that does not touch the database does not leave one
 * behind.
 *
 * `better-sqlite3` is synchronous by design: SQLite reads are memory-speed, and an async wrapper
 * around them buys nothing but a promise per row.
 *
 * Nothing imports this yet — see `schema.ts` for why, and for what will.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DATABASE_URL } from '$app/env/private';
import * as schema from './schema.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The open connection, and the handle underneath it.
 *
 * Both, because Drizzle's wrapper has no `close` — the file handle belongs to `better-sqlite3`, and
 * keeping only the wrapper would make {@link closeDb} a function that drops a reference and calls
 * it closing. The process would hold the file until it exited, which on a test runner means every
 * suite that touched the database.
 */
let open: { readonly db: Db; readonly handle: Database.Database } | null = null;

/**
 * The database, opening it on first use.
 *
 * A function rather than an exported constant precisely so that importing this module does not
 * open a file.
 */
export function db(): Db {
	open ??= (() => {
		const handle = new Database(DATABASE_URL);

		return { handle, db: drizzle(handle, { schema }) };
	})();

	return open.db;
}

/** Closes the connection, if one was opened. For a clean shutdown, and for tests. */
export function closeDb(): void {
	open?.handle.close();
	open = null;
}
