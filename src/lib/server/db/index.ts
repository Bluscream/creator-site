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
 * ### The pragmas are not optional
 *
 * SQLite defaults to foreign keys *off*, per connection. Without `PRAGMA foreign_keys = ON` the
 * `onDelete: 'cascade'` this schema relies on does nothing at all and nothing reports it: deleting a
 * user would leave their sessions behind, resolvable until they expired. It is set here rather than
 * in a migration because it is a property of the connection, not of the file.
 *
 * `journal_mode = WAL` because a reader and a writer otherwise block each other, and a request
 * renewing a session is a writer. `busy_timeout` so a concurrent writer waits rather than throwing
 * `SQLITE_BUSY` at whoever happened to be second.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DATABASE_URL } from '$app/env/private';
import { applyMigrations } from './migrate.js';
import * as schema from './schema.js';

/**
 * Connection settings, applied in order on open.
 *
 * Exported so `index.test.ts` can assert each one actually took: a pragma that is silently ignored —
 * a misspelling, a build without the feature — leaves the database working and the guarantee gone.
 */
export const PRAGMAS = ['foreign_keys = ON', 'journal_mode = WAL', 'busy_timeout = 5000'] as const;

/** The connection type, as every module that takes one needs it. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

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

		for (const pragma of PRAGMAS) handle.pragma(pragma);

		const db = drizzle(handle, { schema });

		// Before the first query rather than as a deploy step, so `docker compose up` on a new
		// version is the whole upgrade. See `./migrate.ts`.
		applyMigrations(db);

		return { handle, db };
	})();

	return open.db;
}

/** Closes the connection, if one was opened. For a clean shutdown, and for tests. */
export function closeDb(): void {
	open?.handle.close();
	open = null;
}
