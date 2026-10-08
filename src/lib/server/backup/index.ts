/**
 * What a backup of this install contains, and how it comes back.
 *
 * `./archive.ts` is the container and knows nothing about this project. This module decides what
 * goes inside one, writes the manifest that describes it, and performs a restore. Everything it
 * refuses is about *contents*: a backup from a newer build, a member nothing here would have
 * written, a database that is not one.
 *
 * ### What is in a backup
 *
 * | entry | what it is |
 * |---|---|
 * | `manifest.json` | what follows, with a digest for each entry |
 * | `database.sqlite` | the database, consistent, via `VACUUM INTO` |
 * | `config/*.json` | every configuration document |
 *
 * Uploads, the enabled theme and the plugin list belong here too and are not written yet, because
 * none of them exist. The format carries them without a change — they are more entries under their
 * own prefixes — and the restore's allow-list is the one place that will need extending.
 *
 * ### The database cannot be copied as a file
 *
 * A live SQLite database has committed data in its write-ahead log that is not in the `.db` file
 * yet. `tar`ing the file produces an archive that restores cleanly in a test and silently loses the
 * most recent writes for somebody months later — which was measured here, not assumed: a snapshot
 * taken with an open writer and twelve kilobytes sitting in the WAL came back complete through
 * `VACUUM INTO` and would not have through a copy. So the database goes through `VACUUM INTO`,
 * which asks SQLite for a consistent snapshot, and is read through a **read-only** connection so
 * that taking a backup can never be the thing that corrupts one.
 *
 * ### Compatibility is the migration list, not a version string
 *
 * `package.json` says `0.0.0` and would keep saying it. What actually determines whether this build
 * can use a database is **which migrations it has**, and Drizzle records that in the database
 * itself. So the manifest carries the applied migration stamps, the restore compares them against
 * the ones this build ships, and a stamp it does not recognise means the backup came from a newer
 * version — refused, by name, rather than opened and found to be missing a column later.
 *
 * Fewer stamps is fine: that is an older backup, and the migrator rolls it forward on the next
 * open. This is the direction that has to work, because it is the one a restore is usually for.
 *
 * ### Nothing is replaced until everything has been checked
 *
 * A restore unpacks to a staging directory inside the data directory, verifies every digest, opens
 * the staged database and asks SQLite whether it is intact, and only then moves things into place.
 * The moves are renames within one filesystem, so the window in which the install is neither the
 * old state nor the new one is as small as the platform allows — and what was there before is kept
 * beside it rather than deleted, because the operator running a restore is already having a bad
 * day and "it replaced my data with a corrupt archive" must not be the next thing that happens.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { DATABASE_URL } from '$app/env/private';
import { closeDb, databaseFile } from '../db/index.js';
import { MIGRATIONS } from '../db/migrate.js';
import { log } from '../log.js';
import { dataPath } from '../paths.js';
import { ArchiveRefusal, readArchive, writeArchive } from './archive.js';
import type { ArchiveEntry } from './archive.js';

/** The manifest format. Independent of the container's, because the two change for own reasons. */
export const MANIFEST_FORMAT = 1;

/** Always the first entry, so an inspection can stop after one member. */
export const MANIFEST_ENTRY = 'manifest.json';

/** The database snapshot. */
export const DATABASE_ENTRY = 'database.sqlite';

/** Everything under here is a configuration document. */
export const CONFIG_PREFIX = 'config/';

/** Where the configuration documents live, relative to the data directory. Mirrors `document.ts`. */
const CONFIG_DIRECTORY = 'config';

/** What a restore renames the previous state to, with a timestamp appended. */
const SUPERSEDED = 'superseded';

/** One member, as the manifest records it. */
const entrySchema = z.object({
	name: z.string().min(1).max(255),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/u)
});

/**
 * What a backup says about itself.
 *
 * Validated on read with the same strictness as any other external document, because a manifest
 * comes out of a file somebody supplied. `.strict()` is deliberate: an unknown field means the
 * archive was written by something that knows more than this build does, and quietly ignoring it
 * is how a restore drops data it was never told about.
 */
export const manifestSchema = z
	.object({
		format: z.number().int().positive(),
		createdAt: z.iso.datetime(),
		/**
		 * Drizzle's `created_at` for each applied migration, which equals the `when` in its journal.
		 * Numbers rather than tags because this is what the *database* records; the tags are a
		 * naming convention of the folder and could be renamed without changing anything.
		 */
		migrations: z.array(z.number().int().nonnegative()),
		entries: z.array(entrySchema)
	})
	.strict();

export type BackupManifest = z.output<typeof manifestSchema>;

/** Why a backup's contents were refused, as distinct from the container refusing its bytes. */
export type RestoreProblem =
	/** No manifest, or not the first entry. */
	| 'manifest_missing'
	/** A manifest this build cannot read, or one from a newer manifest format. */
	| 'manifest_invalid'
	/** A member whose bytes do not match what the manifest says they are. */
	| 'contents_do_not_match_manifest'
	/** A member nothing here would have written. */
	| 'unexpected_entry'
	/** The database has migrations this build does not ship. */
	| 'from_a_newer_build'
	/** The database member is not an intact SQLite database. */
	| 'not_a_database';

/** Thrown when an archive opened cleanly and its contents are not usable. */
export class RestoreRefusal extends Error {
	constructor(
		readonly problem: RestoreProblem,
		message: string,
		options?: { readonly cause?: unknown }
	) {
		super(message, options);
		this.name = 'RestoreRefusal';
	}
}

/** The migration stamps this build ships, from the folder the migrator reads. */
export async function knownMigrations(): Promise<readonly number[]> {
	const journal = JSON.parse(
		await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')
	) as unknown;

	const parsed = z.object({ entries: z.array(z.object({ when: z.number() })) }).safeParse(journal);

	// Not a refusal: a missing or malformed journal is this build being broken, not the backup.
	if (!parsed.success)
		throw new Error('the migration journal shipped with this build is unreadable');

	return parsed.data.entries.map((entry) => entry.when);
}

/** The migration stamps recorded inside a SQLite file, and whether it is intact. */
function inspectDatabase(file: string): readonly number[] {
	let handle;

	try {
		handle = new Database(file, { readonly: true, fileMustExist: true });
	} catch (cause) {
		throw new RestoreRefusal(
			'not_a_database',
			'the database in this backup could not be opened as a SQLite database',
			{ cause }
		);
	}

	try {
		// `integrity_check` rather than trusting the open: SQLite opens a file with a valid header
		// and a shredded middle quite happily, and reports it on the first query that needs the
		// damaged page — which would be after the restore had already replaced everything.
		//
		// Two outcomes, and the tests only reach one of them. Structural damage makes this *throw*
		// `database disk image is malformed`, which the catch below turns into the refusal; that is
		// the path a corrupted archive actually takes here, and deleting this call lets such a file
		// through. SQLite also documents returning a list of problems instead of `ok` for damage it
		// can describe rather than trip over, which is what the comparison is for — a path no test
		// here constructs, kept because the documented contract has both.
		const integrity = handle.pragma('integrity_check') as readonly { integrity_check?: string }[];

		if (integrity[0]?.integrity_check !== 'ok') {
			throw new RestoreRefusal(
				'not_a_database',
				'the database in this backup is damaged: SQLite reports it does not pass an integrity check'
			);
		}

		const rows = handle
			.prepare('select created_at from __drizzle_migrations order by created_at')
			.all() as readonly { created_at?: number }[];

		return rows.map((row) => row.created_at ?? 0);
	} catch (cause) {
		if (cause instanceof RestoreRefusal) throw cause;

		// No `__drizzle_migrations` is the common shape of this: a database from something else, or
		// one this application never created.
		throw new RestoreRefusal(
			'not_a_database',
			'the database in this backup has no migration history, so it was not written by this application',
			{ cause }
		);
	} finally {
		handle.close();
	}
}

/** The sha-256 and size of a file, read once. */
async function digestOf(
	file: string
): Promise<{ readonly bytes: number; readonly sha256: string }> {
	const contents = await readFile(file);

	return {
		bytes: contents.length,
		sha256: createHash('sha256').update(contents).digest('hex')
	};
}

/** A scratch directory inside the data directory, so every later rename stays on one filesystem. */
async function workspace(): Promise<string> {
	const parent = dataPath('.work');

	await mkdir(parent, { recursive: true });

	return mkdtemp(join(parent, 'backup-'));
}

/**
 * Writes a backup of this install.
 *
 * @param path the archive to write. Overwritten if it exists.
 * @param password the only thing protecting it. Strength is the caller's question.
 * @returns the manifest that was written, so a caller can report what it captured without
 *   immediately reading back the file it just produced.
 */
export async function createBackup(path: string, password: string): Promise<BackupManifest> {
	const work = await workspace();

	try {
		const snapshot = join(work, 'database.sqlite');
		const source = databaseFile(DATABASE_URL);
		let migrations: readonly number[] = [];
		let database: ArchiveEntry | null = null;

		// A fresh install that has never opened the database has nothing to snapshot, and that is a
		// legitimate backup — of the configuration — rather than an error. `fileMustExist` makes the
		// difference between "not there" and "there and unreadable" explicit.
		if (await exists(source)) {
			const handle = new Database(source, { readonly: true, fileMustExist: true });

			try {
				// The parameter cannot be bound: `VACUUM INTO ?` is not valid SQLite. The value is not
				// external — it is a path this function just built inside its own scratch directory —
				// so there is nothing here an operator or a request can influence.
				handle.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
			} finally {
				handle.close();
			}

			migrations = inspectDatabase(snapshot);

			const { bytes } = await digestOf(snapshot);

			database = { name: DATABASE_ENTRY, body: { file: snapshot, bytes } };
		}

		const documents = await configDocuments();
		const bodies: readonly ArchiveEntry[] = [
			...(database === null ? [] : [database]),
			...documents.map((document) => ({
				name: `${CONFIG_PREFIX}${document.name}`,
				body: document.contents
			}))
		];

		const manifest: BackupManifest = {
			format: MANIFEST_FORMAT,
			createdAt: new Date().toISOString(),
			migrations: [...migrations],
			entries: await Promise.all(
				bodies.map(async (entry) => ({
					name: entry.name,
					...(Buffer.isBuffer(entry.body)
						? {
								bytes: entry.body.length,
								sha256: createHash('sha256').update(entry.body).digest('hex')
							}
						: await digestOf(entry.body.file))
				}))
			)
		};

		await mkdir(dirname(path), { recursive: true });
		await writeArchive(path, password, [
			{ name: MANIFEST_ENTRY, body: Buffer.from(`${JSON.stringify(manifest, null, '\t')}\n`) },
			...bodies
		]);

		log().info(
			{ entries: manifest.entries.length, database: database !== null },
			'wrote a backup archive'
		);

		return manifest;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/** Whether a path is there at all. */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);

		return true;
	} catch {
		return false;
	}
}

/** Every configuration document, as bytes. */
async function configDocuments(): Promise<
	readonly { readonly name: string; readonly contents: Buffer }[]
> {
	const directory = dataPath(CONFIG_DIRECTORY);

	let names: readonly string[];

	try {
		names = await readdir(directory);
	} catch {
		// Nothing configured yet. A backup of a fresh install is a small one, not a failure.
		return [];
	}

	const wanted = names.filter((name) => name.endsWith('.json')).sort();

	return Promise.all(
		wanted.map(async (name) => ({ name, contents: await readFile(join(directory, name)) }))
	);
}

/** Reads a backup's manifest without unpacking the rest of it. */
export async function inspectBackup(path: string, password: string): Promise<BackupManifest> {
	// A box rather than a plain `let`: assigned from inside a callback, which TypeScript's control
	// flow cannot see, so a bare variable stays narrowed to `null` and the check below reads as
	// dead code. The indirection is the price of that, and is better than asserting past it.
	const found: { value: BackupManifest | null } = { value: null };

	await readArchive(path, password, async (name, body) => {
		const chunks: Buffer[] = [];

		for await (const chunk of body) chunks.push(chunk as Buffer);

		// Every entry is still drained — tar is sequential — but only the first is read. Stopping
		// early would mean destroying the stream, which this reader reports as a failed read.
		if (name === MANIFEST_ENTRY && found.value === null) {
			found.value = parseManifest(Buffer.concat(chunks));
		}
	});

	if (found.value === null) {
		throw new RestoreRefusal(
			'manifest_missing',
			'this archive has no manifest, so it is not a backup of this application'
		);
	}

	return found.value;
}

/** A manifest's bytes, validated. */
function parseManifest(bytes: Buffer): BackupManifest {
	let value: unknown;

	try {
		value = JSON.parse(bytes.toString('utf8'));
	} catch (cause) {
		throw new RestoreRefusal('manifest_invalid', "this backup's manifest is not valid JSON", {
			cause
		});
	}

	const parsed = manifestSchema.safeParse(value);

	if (!parsed.success) {
		throw new RestoreRefusal(
			'manifest_invalid',
			`this backup's manifest is not one this build understands: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`
		);
	}

	if (parsed.data.format > MANIFEST_FORMAT) {
		throw new RestoreRefusal(
			'manifest_invalid',
			`this backup's manifest is format ${String(parsed.data.format)} and this build reads up to ${String(MANIFEST_FORMAT)}`
		);
	}

	return parsed.data;
}

/** What a restore put back. */
export interface RestoreReport {
	readonly manifest: BackupManifest;
	/** Where the replaced state was moved to, in case the restore was the wrong decision. */
	readonly superseded: string;
}

/** Whether an entry name is one a restore will write. */
function isExpected(name: string): boolean {
	return name === DATABASE_ENTRY || (name.startsWith(CONFIG_PREFIX) && name.endsWith('.json'));
}

/**
 * Replaces this install's database and configuration with a backup's.
 *
 * The database connection is closed as part of the swap and reopened lazily on the next query, so
 * the process does not have to be restarted — `db()` migrates on open, which is also what rolls an
 * older backup forward.
 */
export async function restoreBackup(path: string, password: string): Promise<RestoreReport> {
	const work = await workspace();

	try {
		const manifest = await unpack(path, password, work);

		await verify(manifest, work);

		return await swap(manifest, work);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/** Unpacks an archive into `work`, returning its manifest. */
async function unpack(path: string, password: string, work: string): Promise<BackupManifest> {
	// Boxed for the same reason as in `inspectBackup`.
	const manifest: { value: BackupManifest | null } = { value: null };

	await readArchive(path, password, async (name, body) => {
		if (name === MANIFEST_ENTRY) {
			const chunks: Buffer[] = [];

			for await (const chunk of body) chunks.push(chunk as Buffer);

			manifest.value = parseManifest(Buffer.concat(chunks));

			return;
		}

		if (!isExpected(name)) {
			throw new RestoreRefusal(
				'unexpected_entry',
				`this backup contains '${name}', which is not something this build restores`
			);
		}

		const destination = join(work, name);

		await mkdir(dirname(destination), { recursive: true });
		await pipeline(body, createWriteStream(destination));
	});

	if (manifest.value === null) {
		throw new RestoreRefusal(
			'manifest_missing',
			'this archive has no manifest, so it is not a backup of this application'
		);
	}

	return manifest.value;
}

/** Checks everything that can be checked before anything is replaced. */
async function verify(manifest: BackupManifest, work: string): Promise<void> {
	for (const entry of manifest.entries) {
		const file = join(work, entry.name);

		if (!(await exists(file))) {
			throw new RestoreRefusal(
				'contents_do_not_match_manifest',
				`this backup's manifest lists '${entry.name}', which is not in the archive`
			);
		}

		const actual = await digestOf(file);

		if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
			throw new RestoreRefusal(
				'contents_do_not_match_manifest',
				`'${entry.name}' in this backup is not the file its manifest describes`
			);
		}
	}

	const database = join(work, DATABASE_ENTRY);

	if (!(await exists(database))) return;

	const applied = inspectDatabase(database);
	const known = new Set(await knownMigrations());
	const unknown = applied.filter((stamp) => !known.has(stamp));

	if (unknown.length > 0) {
		throw new RestoreRefusal(
			'from_a_newer_build',
			`this backup's database has ${String(unknown.length)} schema change(s) this build does not know about, so it was written by a newer version of this application`
		);
	}
}

/** Moves the verified contents into place, keeping what was there. */
async function swap(manifest: BackupManifest, work: string): Promise<RestoreReport> {
	const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
	const aside = dataPath(`${SUPERSEDED}-${stamp}`);

	await mkdir(aside, { recursive: true });

	// Closed first, and before anything moves: SQLite holds the file open, and replacing a database
	// under a live connection is how a process ends up writing to a file that no longer exists at
	// the path it thinks it is using.
	closeDb();

	const database = join(work, DATABASE_ENTRY);
	const target = databaseFile(DATABASE_URL);

	if (await exists(database)) {
		for (const suffix of ['', '-wal', '-shm']) {
			// The sidecars go too. Leaving a WAL beside a replaced database is the one way to get a
			// file that opens and contains a mixture of two installs.
			if (await exists(`${target}${suffix}`)) {
				await rename(`${target}${suffix}`, join(aside, `database.sqlite${suffix}`));
			}
		}

		await mkdir(dirname(target), { recursive: true });
		await rename(database, target);
	}

	const config = dataPath(CONFIG_DIRECTORY);

	if (await exists(config)) await rename(config, join(aside, CONFIG_DIRECTORY));

	if (await exists(join(work, CONFIG_DIRECTORY))) {
		await rename(join(work, CONFIG_DIRECTORY), config);
	}

	log().warn(
		{ entries: manifest.entries.length, superseded: aside, backup: manifest.createdAt },
		'restored a backup, replacing the database and configuration'
	);

	return { manifest, superseded: aside };
}

export { ArchiveRefusal };
