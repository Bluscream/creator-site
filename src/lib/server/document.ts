/**
 * A JSON configuration document on disk, validated by a schema.
 *
 * This is the product surface: branding, links, feed sources, chat and calendar settings. It is a
 * **file** rather than a database table on purpose, because it is the thing a creator edits, diffs
 * and backs up — `git log` on a config file is a history anyone can read, and restoring one is a
 * copy rather than a migration.
 *
 * ### Reading never fails
 *
 * Every accessor returns a usable document. A missing file, a truncated file, a file somebody is
 * halfway through hand-editing, a file with one malformed entry — each resolves to the schema's
 * defaults for whatever could not be read, and says so in the log.
 *
 * That is not leniency for its own sake. The alternative is that a typo in a config file takes the
 * public site down, which is the worst possible coupling: the person who can fix it is the one who
 * can no longer load the admin to fix it. A schema that fills in defaults means a broken document
 * costs the setting that is broken, and nothing else.
 *
 * The complement is that the admin validates *before* writing, where a mistake can still be
 * reported to the person making it. Strictness belongs at the write, not the read.
 *
 * ### Cached on the file's identity, not on time
 *
 * Re-reading and re-validating a JSON file on every request is waste, but a time-based cache means
 * someone editing the document waits an arbitrary interval to see whether they fixed it. So the
 * cache is keyed on the file's modification time and size: an edit is picked up on the next
 * request, and an unchanged file is parsed once.
 *
 * `mtime` and size together rather than `mtime` alone, because a filesystem with coarse timestamp
 * granularity can give two different writes within the same second the same `mtime` — and the
 * admin's atomic save is a `rename`, which is exactly the case where two writes can land close
 * together.
 *
 * ### Writing is the opposite of reading in every way
 *
 * Reading is lenient, synchronous and cannot fail. {@link Document.write} is strict, asynchronous
 * and returns a refusal:
 *
 * - **Strict**, because the admin is the one place a mistake can still be reported to the person
 *   making it. An invalid document is refused rather than written and defaulted-over later.
 * - **Asynchronous**, because it does four things to disk — back up, prune, write, rename — while a
 *   read is one `readFileSync` of a small file on a path that renders pages.
 * - **Locked**, so the version check and the write are one step. Without the lock two admins who
 *   both passed the check would both write, and the second would silently win.
 * - **Atomic**, by `rename`, so a reader never sees a half-written document. This is the case the
 *   read cache's size check exists for.
 * - **Backed up**, keeping the last {@link BACKUPS}. The point of configuration-as-a-file is that a
 *   mistake is recoverable by copying something back, which requires there to be something.
 *
 * ### The version token is a content hash, not a timestamp
 *
 * An optimistic write says "replace what I read". Identifying that by `mtime` would be wrong in the
 * one case it matters: two saves inside the same coarse timestamp tick produce the same token, so
 * the second would be accepted as though it had seen the first. A hash of the bytes cannot collide
 * that way, costs one read of a small file, and has the useful property that re-saving an unchanged
 * document is not a conflict with itself.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import type { z } from 'zod';
import { log } from './log.js';
import { dataPath } from './paths.js';

/** Where documents live, inside the data directory. */
const DIRECTORY = 'config';

/** Where replaced documents are kept, inside the data directory. */
const BACKUP_DIRECTORY = 'backups';

/**
 * How many previous versions of each document are kept.
 *
 * Enough to undo a bad afternoon rather than to be an archive. These are small files, and the
 * alternative — keeping everything — turns a directory nobody looks at into one nobody can read.
 */
const BACKUPS = 20;

/** The token for a document that does not exist yet. */
const ABSENT = 'absent';

/** How long a write may hold the lock before another process may break it. */
const LOCK_STALE_MS = 10_000;

/** How many digits a backup's sequence number is padded to. See {@link backup}. */
const SEQUENCE_WIDTH = 12;

/** A backup file: a sequence number, a timestamp, and nothing else. */
const SEQUENCED = /^\d{12}-.+\.json$/;

/** What a cached parse is checked against to decide whether it is still current. */
interface Stamp {
	readonly mtimeMs: number;
	readonly size: number;
}

/**
 * Why a write was refused.
 *
 * - `invalid` — the document failed the schema. `issues` says which fields.
 * - `conflict` — the file changed since the version the caller read. `version` is the current one,
 *   so the caller can re-read and show the difference rather than guess.
 * - `failed` — the disk said no. `issues` carries the message.
 */
export type WriteRefusal =
	| { readonly ok: false; readonly reason: 'invalid'; readonly issues: readonly string[] }
	| { readonly ok: false; readonly reason: 'conflict'; readonly version: string }
	| { readonly ok: false; readonly reason: 'failed'; readonly issues: readonly string[] };

/** What a write produced, or why it did not. */
export type WriteResult<T> =
	{ readonly ok: true; readonly version: string; readonly value: T } | WriteRefusal;

/** A validated configuration document, re-read when the file changes. */
export interface Document<T> {
	/** The file this reads, for a message or for the admin to name. */
	readonly path: string;

	/**
	 * The document, validated.
	 *
	 * Never throws and never returns a partial object: whatever could not be read takes the
	 * schema's default.
	 */
	read(): T;

	/**
	 * Drops the cached parse, so the next {@link read} goes back to disk.
	 *
	 * For tests, and for the admin immediately after it writes — a save followed by a read within
	 * the same coarse timestamp tick would otherwise serve what was just replaced.
	 */
	forget(): void;

	/**
	 * A token identifying the document as it is on disk right now.
	 *
	 * Handed to the editor with the document and passed back to {@link write} as `expect`, which is
	 * what turns a save into "replace what I read" rather than "replace whatever is there".
	 * {@link ABSENT} for a document that does not exist, so creating one can be expressed too.
	 */
	version(): string;

	/**
	 * Validates `value`, backs up what is there, and replaces it atomically.
	 *
	 * @param expect the {@link version} the caller is replacing. Omit to overwrite unconditionally,
	 *               which is for a migration or a first-run write, not for an editor.
	 */
	write(value: unknown, options?: { readonly expect?: string }): Promise<WriteResult<T>>;
}

/** The bytes of `path`, or null when there is no file. */
function bytesOf(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

/** A short content hash, which is what a version token is. */
function hash(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/** The issues in a failed parse, as lines an admin can read. */
function issuesOf(error: z.ZodError): readonly string[] {
	return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * The write lock, or null when it could not be taken.
 *
 * Null rather than a throw, because "somebody else is saving" is a refusal the admin shows rather
 * than an error. `realpath: false` because the document may not exist yet, which is the first-run
 * case.
 */
async function acquire(path: string, name: string): Promise<(() => Promise<void>) | null> {
	try {
		return await lock(path, { realpath: false, retries: 2, stale: LOCK_STALE_MS });
	} catch (error) {
		log().error(
			{ document: name, err: error instanceof Error ? error.message : 'unknown' },
			'could not lock a configuration document to write it'
		);

		return null;
	}
}

/** The backups of a document, oldest first. */
async function backupsOf(directory: string): Promise<readonly string[]> {
	try {
		return (await readdir(directory)).filter((entry) => SEQUENCED.test(entry)).toSorted();
	} catch {
		return [];
	}
}

/**
 * Copies the current document aside, then drops all but the newest {@link BACKUPS}.
 *
 * ### Why the name starts with a sequence number
 *
 * The obvious name is a timestamp, with something appended to break ties — and that is wrong in the
 * case that matters. Two saves inside the same millisecond get the same timestamp, so their order
 * is decided by whatever was appended: a hash sorts by content, which is to say arbitrarily. Pruning
 * then deletes by name order and can throw away the *newer* of the two. A test writing 25 documents
 * in a loop caught exactly that, keeping a version older than the window it should have kept.
 *
 * A sequence number one past the highest already present gives a strict total order that no clock
 * can confuse. Reading the directory and writing cannot interleave because the caller holds the
 * write lock, which is the same lock that makes the version check safe. The timestamp stays in the
 * name after it, because a directory of files called `000007` and nothing else is unreadable.
 */
async function backup(name: string, content: Buffer): Promise<void> {
	const directory = dataPath(BACKUP_DIRECTORY, name);

	await mkdir(directory, { recursive: true });

	const existing = await backupsOf(directory);
	const last = existing.at(-1);
	const next = (last === undefined ? 0 : Number(last.slice(0, SEQUENCE_WIDTH))) + 1;

	// Padded to a fixed width so the names sort as numbers do. Twelve digits is not a limit anybody
	// reaches — a save a second for thirty thousand years.
	const sequence = String(next).padStart(SEQUENCE_WIDTH, '0');
	const when = new Date().toISOString().replaceAll(/[:.]/gu, '-');

	await writeFile(join(directory, `${sequence}-${when}.json`), content);

	// Oldest first, so everything past the limit is at the front.
	const kept = [...existing, `${sequence}-${when}.json`];

	await Promise.all(
		kept
			.slice(0, Math.max(0, kept.length - BACKUPS))
			.map((entry) => rm(join(directory, entry), { force: true }))
	);
}

/**
 * Backs up what is there and replaces it atomically. The lock must already be held.
 *
 * @returns the new version token
 */
async function replace(path: string, name: string, value: unknown): Promise<string> {
	// Pretty-printed with tabs, because the whole premise of configuration-as-a-file is that a
	// person reads and diffs it, and a trailing newline because every other text file has one.
	const encoded = `${JSON.stringify(value, null, '\t')}\n`;
	const existing = bytesOf(path);

	if (existing !== null) await backup(name, existing);

	await mkdir(dataPath(DIRECTORY), { recursive: true });

	// Written beside the target and renamed, which is atomic on the same filesystem, so a reader
	// never sees a partial document. The pid is in the name so two processes cannot collide on the
	// temporary file itself.
	const temporary = `${path}.${String(process.pid)}.tmp`;

	try {
		await writeFile(temporary, encoded);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });

		throw error;
	}

	return hash(encoded);
}

/**
 * Whatever is in the file, as unvalidated JSON, or null when there is nothing usable.
 *
 * Null rather than `undefined` so it is distinguishable from a file whose content genuinely is the
 * JSON literal `null`, which should be reported as an invalid document rather than quietly treated
 * as an absent one.
 */
function raw(path: string, name: string): { readonly value: unknown } | null {
	let text: string;

	try {
		text = readFileSync(path, 'utf8');
	} catch {
		// No file. A fresh install, which is the schema's defaults.
		return null;
	}

	try {
		return { value: JSON.parse(text) as unknown };
	} catch (error) {
		// Malformed JSON is worth a log line — it is almost always a hand edit, and the person who
		// made it needs to know why their change had no effect.
		log().error(
			{ document: name, err: error instanceof Error ? error.message : 'unknown' },
			'configuration document is not valid JSON; using defaults'
		);

		return null;
	}
}

/**
 * The document the schema produces from nothing.
 *
 * `{}` rather than `undefined`, which is the thing worth knowing here: an object schema whose every
 * field has a `.default()` still **rejects** `undefined`, because the default applies to a missing
 * property and not to a missing object. Passing `undefined` made every absent file throw, which the
 * tests caught.
 *
 * A schema that cannot answer `{}` is a bug in the schema rather than bad input — a field was
 * written without a default — so this is loud. Silently serving something else would hide it.
 */
function defaults<S extends z.ZodType>(name: string, schema: S): z.output<S> {
	const parsed = schema.safeParse({});

	if (parsed.success) return parsed.data;

	throw new Error(
		`the schema for ${name} cannot produce a document from its own defaults: ${issuesOf(
			parsed.error
		).join('; ')}`
	);
}

/**
 * The file's contents as a complete document, or the defaults when it cannot be one.
 *
 * Two layers, deliberately. A well-written schema defaults or `.catch()`es each field, so one bad
 * entry costs that entry and the rest of the document survives — which is what somebody halfway
 * through an edit needs. This is the backstop underneath that: if the document is unsalvageable, or
 * a field was written without a fallback, the answer is the defaults rather than an exception on a
 * public page.
 */
function validate<S extends z.ZodType>(
	name: string,
	schema: S,
	found: { readonly value: unknown } | null
): z.output<S> {
	if (found === null) return defaults(name, schema);

	const parsed = schema.safeParse(found.value);

	if (parsed.success) return parsed.data;

	log().error(
		{ document: name, issues: issuesOf(parsed.error) },
		'configuration document is invalid; using defaults'
	);

	return defaults(name, schema);
}

/**
 * A document backed by `<data>/config/<name>.json` and validated by `schema`.
 *
 * The schema must produce a complete document from `{}` — in practice, every field has a
 * `.default()`. That is what makes a missing file a supported state rather than a branch every
 * caller has to write, and it is asserted on the first read rather than assumed.
 */
export function document<S extends z.ZodType>(name: string, schema: S): Document<z.output<S>> {
	const path = dataPath(DIRECTORY, `${name}.json`);

	let cached: { readonly stamp: Stamp | null; readonly value: z.output<S> } | null = null;

	/** The file's identity, or null when there is no file. */
	function stamp(): Stamp | null {
		try {
			const info = statSync(path);

			return { mtimeMs: info.mtimeMs, size: info.size };
		} catch {
			return null;
		}
	}

	function same(a: Stamp | null, b: Stamp | null): boolean {
		if (a === null || b === null) return a === b;

		return a.mtimeMs === b.mtimeMs && a.size === b.size;
	}

	return {
		path,

		read(): z.output<S> {
			const current = stamp();

			if (cached !== null && same(cached.stamp, current)) return cached.value;

			cached = { stamp: current, value: validate(name, schema, raw(path, name)) };

			return cached.value;
		},

		forget(): void {
			cached = null;
		},

		version(): string {
			const content = bytesOf(path);

			return content === null ? ABSENT : hash(content);
		},

		async write(value, options): Promise<WriteResult<z.output<S>>> {
			// Validated before anything is locked or touched: the common refusal costs no disk at
			// all, and a document that will not parse should never reach the backup step.
			const parsed = schema.safeParse(value);

			if (!parsed.success) {
				return { ok: false, reason: 'invalid', issues: issuesOf(parsed.error) };
			}

			await mkdir(dataPath(DIRECTORY), { recursive: true });

			// Held across the check and the write, so they are one step. Without it two callers who
			// both passed the version check would both write, and the second would silently win.
			const release = await acquire(path, name);

			if (release === null) {
				return { ok: false, reason: 'failed', issues: ['Another save is in progress.'] };
			}

			try {
				const content = bytesOf(path);
				const current = content === null ? ABSENT : hash(content);

				if (options?.expect !== undefined && options.expect !== current) {
					return { ok: false, reason: 'conflict', version: current };
				}

				const written = await replace(path, name, parsed.data);

				// The read cache is keyed on mtime and size, and a rename inside the same coarse tick
				// can change neither. Dropping it is what makes the next read see what was written.
				cached = null;

				log().info({ document: name }, 'configuration document written');

				return { ok: true, version: written, value: parsed.data };
			} catch (error) {
				// A full disk, a read-only mount, a permission the container does not have. Logged
				// with its message and reported as a refusal rather than thrown, so the admin shows
				// the save as failed instead of answering 500.
				log().error(
					{ document: name, err: error instanceof Error ? error.message : 'unknown' },
					'writing a configuration document failed'
				);

				return {
					ok: false,
					reason: 'failed',
					issues: ['The document could not be saved. See the server log.']
				};
			} finally {
				await release();
			}
		}
	};
}
