/**
 * That a configuration document is readable whatever state the file is in.
 *
 * The promise this module makes is that reading never fails — a typo in a config file must cost the
 * setting that is broken and nothing else, because the person who can fix it is otherwise the
 * person who can no longer load the admin to fix it. Most of these cases are therefore a *damaged*
 * file, and they assert what survives rather than that an error was raised.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { document } from './document.js';
import type { WriteResult } from './document.js';

let directory: string;

/** The schema these cases use: one plain field, one bounded, one tolerant list. */
const schema = z.object({
	enabled: z.boolean().default(true),
	limit: z.number().int().min(1).max(100).default(24),
	names: z
		.array(z.string().min(1).nullable().catch(null))
		.default([])
		.transform((entries) => entries.filter((entry): entry is string => entry !== null))
});

/** Writes the document file, creating the config directory. */
function writeDocument(name: string, contents: string): string {
	const path = join(directory, 'config', `${name}.json`);

	mkdirSync(join(directory, 'config'), { recursive: true });
	writeFileSync(path, contents, 'utf8');

	return path;
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'creator-site-document-'));
	vi.stubEnv('DATA_DIR', directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('a document with no file', () => {
	it('reads as the schema defaults, because a fresh install is not a failure', () => {
		expect(document('missing', schema).read()).toStrictEqual({
			enabled: true,
			limit: 24,
			names: []
		});
	});

	it('names the file it would read, for a message', () => {
		expect(document('missing', schema).path).toBe(join(directory, 'config', 'missing.json'));
	});
});

describe('a valid document', () => {
	it('is read as written', () => {
		writeDocument('feed', JSON.stringify({ enabled: false, limit: 5, names: ['a', 'b'] }));

		expect(document('feed', schema).read()).toStrictEqual({
			enabled: false,
			limit: 5,
			names: ['a', 'b']
		});
	});

	it('fills in the fields it does not mention', () => {
		writeDocument('feed', JSON.stringify({ limit: 7 }));

		expect(document('feed', schema).read()).toStrictEqual({
			enabled: true,
			limit: 7,
			names: []
		});
	});
});

describe('a damaged document', () => {
	it('falls back to defaults when the JSON does not parse', () => {
		writeDocument('feed', '{ "limit": 5,,, ');

		expect(document('feed', schema).read().limit).toBe(24);
	});

	it('falls back to defaults when a field is the wrong type', () => {
		// `limit` has no `.catch()`, so the whole document cannot be built and the backstop answers.
		writeDocument('feed', JSON.stringify({ limit: 'twelve' }));

		expect(document('feed', schema).read().limit).toBe(24);
	});

	it('falls back to defaults when a field is out of bounds', () => {
		writeDocument('feed', JSON.stringify({ limit: 10_000 }));

		expect(document('feed', schema).read().limit).toBe(24);
	});

	it('drops only the bad entry from a tolerant list, keeping the rest', () => {
		// This is the layer that matters in practice: a half-filled row is a normal state for a file
		// somebody is editing, and it must not cost the other rows.
		writeDocument('feed', JSON.stringify({ limit: 5, names: ['a', '', 42, 'b', null] }));

		expect(document('feed', schema).read()).toStrictEqual({
			enabled: true,
			limit: 5,
			names: ['a', 'b']
		});
	});

	it('still reads the other fields when a list entry is bad', () => {
		writeDocument('feed', JSON.stringify({ enabled: false, limit: 9, names: [99] }));

		expect(document('feed', schema).read()).toStrictEqual({
			enabled: false,
			limit: 9,
			names: []
		});
	});

	it('reads an empty file as defaults', () => {
		writeDocument('feed', '');

		expect(document('feed', schema).read().limit).toBe(24);
	});

	it('reads a JSON value that is not an object as defaults', () => {
		writeDocument('feed', '"a string"');

		expect(document('feed', schema).read().limit).toBe(24);
	});
});

describe('picking up an edit', () => {
	it('re-reads when the file changes', () => {
		writeDocument('feed', JSON.stringify({ limit: 5 }));

		const doc = document('feed', schema);

		expect(doc.read().limit).toBe(5);

		writeDocument('feed', JSON.stringify({ limit: 9 }));

		expect(doc.read().limit).toBe(9);
	});

	it('notices a change that keeps the same modification time', () => {
		// A filesystem with coarse timestamp granularity can give two writes the same mtime, and the
		// admin's save is a rename, which is exactly when two writes land close together. Size is
		// the other half of the stamp for that reason. Forced here rather than hoped for.
		const path = writeDocument('feed', JSON.stringify({ limit: 5 }));
		const when = new Date(1_700_000_000_000);

		utimesSync(path, when, when);

		const doc = document('feed', schema);

		expect(doc.read().limit).toBe(5);

		writeDocument('feed', JSON.stringify({ limit: 55 }));
		utimesSync(path, when, when);

		expect(doc.read().limit).toBe(55);
	});

	it('notices a file appearing where there was none', () => {
		const doc = document('feed', schema);

		expect(doc.read().limit).toBe(24);

		writeDocument('feed', JSON.stringify({ limit: 8 }));

		expect(doc.read().limit).toBe(8);
	});

	it('goes back to disk after being told to forget', () => {
		writeDocument('feed', JSON.stringify({ limit: 5 }));

		const doc = document('feed', schema);

		expect(doc.read().limit).toBe(5);

		doc.forget();

		expect(doc.read().limit).toBe(5);
	});
});

describe('a schema that cannot default', () => {
	it('throws, because that is a bug in the schema rather than bad input', () => {
		// Every field is meant to have a default so that an absent file is a working configuration.
		// A schema that does not is a programming error, and silently serving something else would
		// hide it.
		const required = z.object({ name: z.string() });

		expect(() => document('broken', required).read()).toThrow(/cannot produce a document/);
	});
});

/**
 * A refusal's issue lines, or an empty list.
 *
 * A helper rather than an inline conditional at each use, because narrowing a discriminated union
 * inside an `expect` argument reads as noise and the lint rules object to it with reason.
 */
function issuesOf(result: WriteResult<unknown>): readonly string[] {
	return !result.ok && result.reason !== 'conflict' ? result.issues : [];
}

/** The version a conflict reports, or null. */
function conflictVersion(result: WriteResult<unknown>): string | null {
	return !result.ok && result.reason === 'conflict' ? result.version : null;
}

/**
 * Writing, which is the opposite of reading in every way that matters.
 *
 * Reading is lenient and cannot fail; writing is strict and refuses. The cases worth having are the
 * ones where a plausible implementation loses data: a save that clobbers a concurrent one, a save
 * that leaves no way back, and a save that leaves a half-written file behind.
 */
describe('writing a document', () => {
	/** Every backup kept for a document, oldest first. */
	function backupsOf(name: string): string[] {
		try {
			return readdirSync(join(directory, 'backups', name)).toSorted();
		} catch {
			return [];
		}
	}

	it('creates the document and its directory on a fresh install', async () => {
		const config = document('fresh', schema);
		const written = await config.write({ limit: 7 });

		expect(written.ok).toBe(true);
		expect(config.read().limit).toBe(7);
	});

	it('fills in the defaults, so the file on disk is the whole document', async () => {
		// A creator reading the file should see every setting, not only the ones they changed.
		const config = document('whole', schema);

		await config.write({ limit: 7 });

		expect(JSON.parse(readFileSync(config.path, 'utf8'))).toStrictEqual({
			enabled: true,
			limit: 7,
			names: []
		});
	});

	it('writes something a person can read and diff', async () => {
		const config = document('pretty', schema);

		await config.write({ limit: 7 });

		const text = readFileSync(config.path, 'utf8');

		expect(text).toContain('\n\t"limit": 7');
		expect(text.endsWith('\n')).toBe(true);
	});

	it('refuses a document the schema rejects, and says which field', async () => {
		// Strictness belongs here: this is the one place a mistake can still be reported to the
		// person making it, rather than silently defaulted over on the next read.
		const config = document('invalid', schema);
		const refused = await config.write({ limit: 10_000 });

		expect(refused).toMatchObject({ ok: false, reason: 'invalid' });
		expect(issuesOf(refused)).toContain('limit: Too big: expected number to be <=100');
	});

	it('does not touch the disk when it refuses', async () => {
		// The existing document must survive a rejected save, and no backup should be taken of it.
		writeDocument('untouched', JSON.stringify({ limit: 5 }));

		const config = document('untouched', schema);

		await config.write({ limit: 10_000 });

		expect(config.read().limit).toBe(5);
		expect(backupsOf('untouched')).toStrictEqual([]);
	});

	it('is visible to the next read, despite the cache', async () => {
		// The read cache is keyed on mtime and size. A rename inside the same coarse timestamp tick
		// can change neither, so the write has to drop the cache or serve what it just replaced.
		writeDocument('cached', JSON.stringify({ limit: 5 }));

		const config = document('cached', schema);

		expect(config.read().limit).toBe(5);

		await config.write({ limit: 6 });

		expect(config.read().limit).toBe(6);
	});

	it('keeps what it replaced, so a mistake is recoverable', async () => {
		writeDocument('kept', JSON.stringify({ limit: 5 }));

		const config = document('kept', schema);

		await config.write({ limit: 6 });

		const backups = backupsOf('kept');

		expect(backups).toHaveLength(1);
		expect(
			JSON.parse(readFileSync(join(directory, 'backups', 'kept', backups[0] ?? ''), 'utf8'))
		).toStrictEqual({ limit: 5 });
	});

	it('does not back up a document that did not exist', async () => {
		const config = document('nothing-to-keep', schema);

		await config.write({ limit: 1 });

		expect(backupsOf('nothing-to-keep')).toStrictEqual([]);
	});

	it('keeps twenty versions and no more', async () => {
		const config = document('pruned', schema);

		// 22 writes: the first creates the file, so 21 of them replace something.
		for (let limit = 1; limit <= 22; limit += 1) {
			await config.write({ limit });
		}

		expect(backupsOf('pruned')).toHaveLength(20);
	});

	it('keeps the newest twenty, not the oldest', async () => {
		const config = document('pruned-order', schema);

		for (let limit = 1; limit <= 25; limit += 1) {
			await config.write({ limit });
		}

		const backups = backupsOf('pruned-order');
		const limits = backups.map(
			(entry) =>
				(
					JSON.parse(readFileSync(join(directory, 'backups', 'pruned-order', entry), 'utf8')) as {
						limit: number;
					}
				).limit
		);

		// The last backup taken is of the document written by the second-to-last write.
		expect(limits.at(-1)).toBe(24);
		expect(Math.min(...limits)).toBe(5);
	});

	it('does not lose a backup to another save in the same millisecond', async () => {
		// Named by timestamp alone, two saves inside one tick would give the second backup the
		// first's name and the earlier version would be gone.
		const config = document('same-tick', schema);

		await config.write({ limit: 1 });
		await Promise.all([config.write({ limit: 2 }), config.write({ limit: 3 })]);

		expect(backupsOf('same-tick').length).toBeGreaterThanOrEqual(2);
	});
});

describe('an optimistic write', () => {
	it('accepts a save against the version that was read', async () => {
		writeDocument('optimistic', JSON.stringify({ limit: 5 }));

		const config = document('optimistic', schema);
		const seen = config.version();

		expect(await config.write({ limit: 6 }, { expect: seen })).toMatchObject({ ok: true });
	});

	it('refuses a save against a version that has been replaced', async () => {
		// Two admins with the editor open. The second must be told rather than silently winning.
		writeDocument('clobber', JSON.stringify({ limit: 5 }));

		const config = document('clobber', schema);
		const seen = config.version();

		await config.write({ limit: 6 });

		const refused = await config.write({ limit: 7 }, { expect: seen });

		expect(refused).toMatchObject({ ok: false, reason: 'conflict' });
		expect(config.read().limit).toBe(6);
	});

	it('hands back the current version with the conflict, so the caller can show it', async () => {
		writeDocument('conflict-version', JSON.stringify({ limit: 5 }));

		const config = document('conflict-version', schema);
		const stale = config.version();

		await config.write({ limit: 6 });

		const refused = await config.write({ limit: 7 }, { expect: stale });

		expect(conflictVersion(refused)).toBe(config.version());
	});

	it('identifies a version by content, not by timestamp', () => {
		// Two writes inside the same coarse tick produce the same mtime. A timestamp-based token
		// would make the second save look like it had seen the first.
		writeDocument('by-content', JSON.stringify({ limit: 5 }));

		const config = document('by-content', schema);
		const before = config.version();

		writeDocument('by-content', JSON.stringify({ limit: 6 }));
		utimesSync(config.path, new Date(0), new Date(0));

		expect(config.version()).not.toBe(before);
	});

	it('is not a conflict with itself when the document has not changed', async () => {
		writeDocument('idempotent', JSON.stringify({ limit: 5 }));

		const config = document('idempotent', schema);
		const seen = config.version();

		expect(await config.write({ limit: 5 }, { expect: seen })).toMatchObject({ ok: true });
	});

	it('expresses creating a document that does not exist yet', async () => {
		const config = document('creation', schema);

		expect(config.version()).toBe('absent');
		expect(await config.write({ limit: 3 }, { expect: 'absent' })).toMatchObject({ ok: true });
	});

	it('refuses a creation when somebody else got there first', async () => {
		const config = document('race-to-create', schema);
		const absent = config.version();

		writeDocument('race-to-create', JSON.stringify({ limit: 9 }));

		expect(await config.write({ limit: 3 }, { expect: absent })).toMatchObject({
			ok: false,
			reason: 'conflict'
		});
	});

	it('overwrites unconditionally when no version is given', async () => {
		// For a migration or a first-run write, where there is no editor to conflict with.
		writeDocument('unconditional', JSON.stringify({ limit: 5 }));

		const config = document('unconditional', schema);

		expect(await config.write({ limit: 6 })).toMatchObject({ ok: true });
		expect(config.read().limit).toBe(6);
	});

	it('returns the new version, so an editor can save twice without re-reading', async () => {
		const config = document('chained', schema);
		const first = await config.write({ limit: 1 });

		expect(first.ok).toBe(true);

		const next = first.ok ? first.version : '';

		expect(await config.write({ limit: 2 }, { expect: next })).toMatchObject({ ok: true });
	});
});
