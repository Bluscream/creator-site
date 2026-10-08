/**
 * The two i18n gaps the README carried as known and open, now closed.
 *
 * Both needed a UI to exist before they could mean anything: the first has nothing to scan without
 * markup, and the second would have reported every key in the catalogue while the catalogue ran
 * ahead of the pages.
 *
 * These read the real files from disk rather than a fixture, because the thing being checked *is*
 * the project's own source. A fixture would check the checker and leave the project unchecked,
 * which is how a coverage test comes to pass while the page it covers is in the wrong language.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { globSync } from 'tinyglobby';
import { aliasedImports, hardcodedStrings, referencedKeys } from '#lib/i18n-coverage.js';
import baseCatalogue from '../../messages/en.json' with { type: 'json' };

const root = fileURLToPath(new URL('../..', import.meta.url));

const read = (file: string): string => readFileSync(`${root}${file}`, 'utf8');

const componentFiles = globSync(['src/**/*.svelte'], { cwd: root }).sort();
const codeFiles = globSync(['src/**/*.{ts,svelte}'], {
	cwd: root,
	ignore: ['src/lib/paraglide/**', 'src/**/*.test.ts', 'src/**/*.e2e.ts']
}).sort();

/** Every key in the base catalogue. `$schema` is metadata, not a message. */
const catalogueKeys = Object.keys(baseCatalogue).filter((key) => !key.startsWith('$'));

describe('the parser this is built on', () => {
	// Checked first, and with cases that would each defeat a regex over the file. A scanner that
	// reported nothing because it was looking in the wrong place would otherwise look like a
	// project with no hardcoded strings in it.
	it('finds text in markup', () => {
		expect(hardcodedStrings('x.svelte', '<p>Save</p>')).toHaveLength(1);
	});

	it('does not mistake a string in the script block for a label', () => {
		expect(
			hardcodedStrings('x.svelte', '<script lang="ts">const a = "Save";</script><p>{a}</p>')
		).toEqual([]);
	});

	it('does not mistake CSS content for a label', () => {
		expect(hardcodedStrings('x.svelte', '<style>.a::after { content: "Save"; }</style>')).toEqual(
			[]
		);
	});

	it('does not mistake a comment for a label', () => {
		expect(hardcodedStrings('x.svelte', '<!-- Save the thing --><p>{x}</p>')).toEqual([]);
	});

	it('does not mistake an attribute for text', () => {
		// An attribute may well need translating, but it is a separate question with separate
		// answers — `class` never does, `aria-label` always does — and lumping them together would
		// make the check unusable.
		expect(hardcodedStrings('x.svelte', '<p class="Save me">{x}</p>')).toEqual([]);
	});

	it('ignores punctuation, digits and symbols on their own', () => {
		// A separator or an arithmetic sign reads the same in every language here.
		for (const markup of ['<p>—</p>', '<p>·</p>', '<p>:</p>', '<p>42</p>', '<p>( )</p>']) {
			expect(hardcodedStrings('x.svelte', markup)).toEqual([]);
		}
	});

	it('reports the line, so the failure says where to look', () => {
		const found = hardcodedStrings('x.svelte', '<div>\n\t<p>{x}</p>\n\t<p>Save</p>\n</div>');

		expect(found[0]?.line).toBe(3);
	});

	it('finds message references', () => {
		expect(referencedKeys(['m.chat_empty()', 'const a = m.nav_home();'])).toEqual(
			new Set(['chat_empty', 'nav_home'])
		);
	});

	it('does not match something that merely ends in m', () => {
		expect(referencedKeys(['form.chat_empty()', 'stream.nav_home()'])).toEqual(new Set());
	});

	it('spots the import that would hide every call in a file', () => {
		expect(
			aliasedImports(["import * as paraglide from '#lib/paraglide/messages.js';"])
		).toHaveLength(1);
	});

	it('is satisfied by the one name the project uses', () => {
		expect(aliasedImports(["import * as m from '#lib/paraglide/messages.js';"])).toEqual([]);
	});
});

/**
 * The check the PHP admin needed and did not have.
 *
 * Headings and placeholders rendered English on a German page for months, because nothing compares
 * markup against a catalogue — a string that was never a key cannot be a missing translation.
 */
describe('every visible string goes through a message function', () => {
	it('has components to check', () => {
		// Otherwise this whole block passes by having nothing to look at, which is exactly how it
		// would have passed before the chat page existed.
		expect(componentFiles.length).toBeGreaterThan(0);
	});

	it.each(componentFiles)('%s', (file) => {
		const found = hardcodedStrings(file, read(file));

		expect(
			found,
			found.map((hit) => `${hit.file}:${String(hit.line)} — ${JSON.stringify(hit.text)}`).join('\n')
		).toEqual([]);
	});
});

describe('every catalogue key is used', () => {
	const used = referencedKeys(codeFiles.map(read));

	it('finds references at all', () => {
		// A glob that matched nothing, or an import style this does not recognise, would otherwise
		// report the entire catalogue as dead and be ignored for it.
		expect(used.size).toBeGreaterThan(0);
	});

	it('imports the catalogue under the one name the scan recognises', () => {
		// The failure this exists for, which cost nine keys: a file importing the catalogue as
		// `paraglide` had all of its calls invisible to `referencedKeys`, so its messages were
		// reported as dead *and* a key it had missed would have been reported as covered. Both
		// directions of the check were wrong at once, and the output looked plausible.
		const aliased = aliasedImports(codeFiles.map(read));

		expect(aliased, `the catalogue is \`m\` everywhere:\n${aliased.join('\n')}`).toEqual([]);
	});

	it('has no key nothing refers to', () => {
		const dead = catalogueKeys.filter((key) => !used.has(key)).sort();

		expect(dead, `dead keys, costing a translator nothing but time:\n${dead.join('\n')}`).toEqual(
			[]
		);
	});

	it('refers to no key the catalogue lacks', () => {
		// The other direction, and the one that reaches a reader: Paraglide resolves a missing key to
		// its own name, so a typo renders `chat_emtpy` on the page rather than failing.
		const missing = [...used].filter((key) => !catalogueKeys.includes(key)).sort();

		expect(missing, `referenced but not in the catalogue:\n${missing.join('\n')}`).toEqual([]);
	});
});
