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
 */

import { readFileSync, statSync } from 'node:fs';
import type { z } from 'zod';
import { log } from './log.js';
import { dataPath } from './paths.js';

/** Where documents live, inside the data directory. */
const DIRECTORY = 'config';

/** What a cached parse is checked against to decide whether it is still current. */
interface Stamp {
	readonly mtimeMs: number;
	readonly size: number;
}

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

	/**
	 * Whatever is in the file, as unvalidated JSON, or null when there is nothing usable.
	 *
	 * Null rather than `undefined` so it is distinguishable from a file whose content genuinely is
	 * the JSON literal `null`, which should be reported as an invalid document rather than quietly
	 * treated as an absent one.
	 */
	function raw(): { readonly value: unknown } | null {
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
			// Malformed JSON is worth a log line — it is almost always a hand edit, and the person
			// who made it needs to know why their change had no effect.
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
	 * `{}` rather than `undefined`, which is the thing worth knowing here: an object schema whose
	 * every field has a `.default()` still **rejects** `undefined`, because the default applies to a
	 * missing property and not to a missing object. Passing `undefined` made every absent file
	 * throw, which the tests caught.
	 *
	 * A schema that cannot answer `{}` is a bug in the schema rather than bad input — a field was
	 * written without a default — so this is loud. Silently serving something else would hide it.
	 */
	function defaults(): z.output<S> {
		const parsed = schema.safeParse({});

		if (parsed.success) return parsed.data;

		throw new Error(
			`the schema for ${name} cannot produce a document from its own defaults: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
				.join('; ')}`
		);
	}

	/**
	 * The file's contents as a complete document, or the defaults when it cannot be one.
	 *
	 * Two layers, deliberately. A well-written schema defaults or `.catch()`es each field, so one
	 * bad entry costs that entry and the rest of the document survives — which is what somebody
	 * halfway through an edit needs. This is the backstop underneath that: if the document is
	 * unsalvageable, or a field was written without a fallback, the answer is the defaults rather
	 * than an exception on a public page.
	 */
	function validate(found: { readonly value: unknown } | null): z.output<S> {
		if (found === null) return defaults();

		const parsed = schema.safeParse(found.value);

		if (parsed.success) return parsed.data;

		log().error(
			{
				document: name,
				issues: parsed.error.issues.map(
					(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
				)
			},
			'configuration document is invalid; using defaults'
		);

		return defaults();
	}

	return {
		path,

		read(): z.output<S> {
			const current = stamp();

			if (cached !== null && same(cached.stamp, current)) return cached.value;

			cached = { stamp: current, value: validate(raw()) };

			return cached.value;
		},

		forget(): void {
			cached = null;
		}
	};
}
