/**
 * A real database, in memory, for tests.
 *
 * Here rather than in one of the test files so two suites can share it without importing each
 * other — a test file that another test file imports runs twice, once per importer, and its
 * lifecycle hooks run in the wrong suite.
 *
 * ### Why a real SQLite rather than a stubbed `db()`
 *
 * Everything worth testing about `accounts.ts` and `session.ts` is a database behaviour: the
 * `(provider, provider_user_id)` unique index is what makes a second sign-in find the existing
 * user, `onDelete: 'cascade'` is what removes a deleted user's sessions, and a transaction is what
 * keeps a user without an identity from existing. A fake that answers queries from a `Map` would
 * pass all three while the real schema got any of them wrong.
 *
 * `:memory:` so nothing is left on disk, and so each test can have its own database rather than
 * cleaning up after the last one.
 *
 * ### Why the DDL is written out here
 *
 * Drizzle generates migrations through its CLI, not at runtime, so there is no in-process "create
 * every table in the schema" call to make. The statements below are therefore a second copy of
 * `../db/schema.ts`, and that is a real cost: a column added there and not here produces a test
 * failure about a missing column rather than about the behaviour under test.
 *
 * It is still the better trade than pointing the suite at a migrated file on disk, which would make
 * every unit test depend on `drizzle-kit` having been run. The drift is covered rather than hoped
 * about: `../db/migrate.test.ts` applies the committed migrations to an empty database and compares
 * every column, type, null-ness, default and index against this DDL, so the two cannot disagree
 * without a test failing — and {@link drizzleTables} names every table the schema module declares,
 * which is how a suite notices a table missing here entirely.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '#lib/server/db/schema.js';

/** The same type `db()` returns, so a mocked `db()` is assignable to the real one. */
export type MemoryDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The tables, as SQL.
 *
 * `PRAGMA foreign_keys` because SQLite does not enforce foreign keys unless asked, per connection —
 * without it the cascade this schema relies on silently does nothing and a test asserting it would
 * pass for the wrong reason.
 */
const DDL = [
	'PRAGMA foreign_keys = ON',

	// `NOT NULL` on the primary keys because a `TEXT PRIMARY KEY` in SQLite is otherwise nullable, and
	// the generated migrations say `NOT NULL`. `db/migrate.test.ts` caught the difference.
	`CREATE TABLE users (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		avatar_url TEXT,
		role TEXT NOT NULL,
		created_at INTEGER NOT NULL DEFAULT (unixepoch())
	)`,

	`CREATE TABLE identities (
		provider TEXT NOT NULL,
		provider_user_id TEXT NOT NULL,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL DEFAULT (unixepoch())
	)`,

	'CREATE UNIQUE INDEX identities_provider_user ON identities (provider, provider_user_id)',
	'CREATE INDEX identities_user ON identities (user_id)',

	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
		created_at INTEGER NOT NULL DEFAULT (unixepoch())
	)`,

	`CREATE TABLE connections (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		platform TEXT NOT NULL,
		platform_account_id TEXT NOT NULL,
		handle TEXT,
		display_name TEXT,
		avatar_url TEXT,
		method TEXT NOT NULL,
		access_token TEXT,
		refresh_token TEXT,
		expires_at INTEGER,
		scopes TEXT NOT NULL DEFAULT '',
		shown INTEGER NOT NULL DEFAULT false,
		created_at INTEGER NOT NULL DEFAULT (unixepoch()),
		updated_at INTEGER NOT NULL DEFAULT (unixepoch())
	)`,

	'CREATE UNIQUE INDEX connections_platform_account ON connections (platform, platform_account_id)',
	'CREATE INDEX connections_user ON connections (user_id)',
	'CREATE INDEX connections_platform ON connections (platform)',

	'CREATE INDEX sessions_user ON sessions (user_id)',
	'CREATE INDEX sessions_expires ON sessions (expires_at)',

	`CREATE TABLE api_tokens (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		hint TEXT NOT NULL,
		ability TEXT NOT NULL,
		expires_at INTEGER,
		last_used_at INTEGER,
		created_at INTEGER NOT NULL DEFAULT (unixepoch())
	)`,

	'CREATE INDEX api_tokens_user ON api_tokens (user_id)',
	'CREATE INDEX api_tokens_expires ON api_tokens (expires_at)'
] as const;

/** Every table name the Drizzle schema declares. */
export function drizzleTables(): readonly string[] {
	return Object.values(schema)
		.map((value) => tableNameOf(value))
		.filter((name): name is string => name !== null)
		.toSorted();
}

/**
 * The SQL name of a Drizzle table, or null for anything else exported by the schema module.
 *
 * Drizzle keeps it behind a symbol rather than a property, so this reads the symbol by description
 * instead of importing a private name that a minor version may move.
 */
function tableNameOf(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) return null;

	const key = Object.getOwnPropertySymbols(value).find(
		(symbol) => symbol.description === 'drizzle:Name'
	);

	if (key === undefined) return null;

	const name = (value as Record<symbol, unknown>)[key];

	return typeof name === 'string' ? name : null;
}

/** An open in-memory database with the schema applied, plus the handle to close it. */
export interface OpenMemoryDb {
	readonly db: MemoryDb;
	readonly close: () => void;

	/** For asserting on raw columns — what a row literally holds, not what Drizzle maps it to. */
	readonly rows: (sql: string) => readonly Record<string, unknown>[];

	/**
	 * For writing a row a test needs and the code under test would not produce — a role no version
	 * ever had, a user deleted behind a session's back. Parameters are bound rather than interpolated
	 * so a uuid with a quote in it could not break the statement.
	 */
	readonly exec: (sql: string, ...parameters: readonly string[]) => void;
}

/** Opens one. The caller closes it; `afterEach` is the usual place. */
export function memoryDb(): OpenMemoryDb {
	const handle = new Database(':memory:');

	for (const statement of DDL) handle.exec(statement);

	return {
		db: drizzle(handle, { schema }),
		close: () => {
			handle.close();
		},
		rows: (sql) => handle.prepare(sql).all() as readonly Record<string, unknown>[],
		exec: (sql, ...parameters) => {
			handle.prepare(sql).run(...parameters);
		}
	};
}
