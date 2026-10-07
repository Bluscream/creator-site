/**
 * That a configuration document is readable whatever state the file is in.
 *
 * The promise this module makes is that reading never fails — a typo in a config file must cost the
 * setting that is broken and nothing else, because the person who can fix it is otherwise the
 * person who can no longer load the admin to fix it. Most of these cases are therefore a *damaged*
 * file, and they assert what survives rather than that an error was raised.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { document } from './document.js';

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
