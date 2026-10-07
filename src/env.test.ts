/**
 * `.env.example` against `src/env.ts`.
 *
 * The example file is the first thing someone installing this reads, and it is the one kind of
 * documentation that goes stale without anybody noticing: adding a variable to `env.ts` makes the
 * application read it, and nothing anywhere complains that nobody was told it exists. The failure
 * shows up as a self-hoster asking why an integration does nothing.
 *
 * So the two are compared, in both directions. A variable in `env.ts` must be documented; a
 * variable in the example must be real, because a stale line is worse than a missing one — someone
 * will set it and expect something to happen.
 *
 * ### Read as text, not imported
 *
 * `defineEnvVars` exists to generate types and to validate at startup; what it returns at runtime
 * is SvelteKit's business and not a contract to build a test on. The declarations are read from the
 * source instead, which is also the only way to check the *example*, since that is a text file with
 * commented-out lines in it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

const read = (file: string): string => readFileSync(`${root}${file}`, 'utf8');

/**
 * The variables `env.ts` declares.
 *
 * One tab of indentation is the key of the `defineEnvVars({ … })` object literal; anything deeper
 * belongs to a variable's own options. Written against this file's formatting, which Prettier
 * enforces, so it cannot drift silently — and if it ever did, this reports every variable as
 * undocumented rather than quietly matching nothing.
 */
function declaredVariables(source: string): readonly string[] {
	return Array.from(source.matchAll(/^\t([A-Z][A-Z0-9_]*): \{$/gm), (match) => match[1] ?? '');
}

/**
 * The variables `.env.example` mentions, set or commented out.
 *
 * A commented line counts: the file's whole convention is that optional variables are shown
 * commented, so requiring them to be live would mean shipping an example that sets everything.
 */
function documentedVariables(example: string): readonly string[] {
	return Array.from(example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm), (match) => match[1] ?? '');
}

const declared = declaredVariables(read('src/env.ts'));
const documented = documentedVariables(read('.env.example'));

describe('the parsers these checks rest on', () => {
	it('reads a declaration', () => {
		expect(declaredVariables('export const variables = defineEnvVars({\n\tFOO: {\n')).toEqual([
			'FOO'
		]);
	});

	it('does not mistake a nested option for a variable', () => {
		// `schema:` and `description:` are deeper, and a lowercase key is not a variable name.
		expect(declaredVariables('\tFOO: {\n\t\tBAR: {\n\t\tdescription: 1\n')).toEqual(['FOO']);
	});

	it('reads both a set line and a commented one', () => {
		expect(documentedVariables('A=1\n# B=\n#C=2\n')).toEqual(['A', 'B', 'C']);
	});

	it('does not mistake prose for a setting', () => {
		// The example file is mostly comments, and they talk about these variables by name.
		expect(
			documentedVariables('# Set DATABASE_URL to a path.\n# See SYNCHRA_TOKEN above.\n')
		).toEqual([]);
	});
});

describe('.env.example', () => {
	it('found the declarations at all', () => {
		// Otherwise both checks below pass by comparing two empty lists, which is exactly how a
		// changed formatting convention would hide them.
		expect(declared.length).toBeGreaterThan(5);
		expect(documented.length).toBeGreaterThan(5);
	});

	it('documents every variable the application reads', () => {
		const missing = declared.filter((name) => !documented.includes(name)).sort();

		expect(
			missing,
			`declared in src/env.ts and not mentioned in .env.example:\n${missing.join('\n')}`
		).toEqual([]);
	});

	it('mentions no variable the application does not read', () => {
		// A line someone will set, expecting something to happen. Worse than an absent one.
		const unknown = documented.filter((name) => !declared.includes(name)).sort();

		expect(
			unknown,
			`in .env.example and not declared in src/env.ts:\n${unknown.join('\n')}`
		).toEqual([]);
	});

	it('leaves the required variable set and the optional ones commented', () => {
		// The example has to work when copied to `.env` unedited, and it only does if exactly the
		// required variable is live. An optional one set to an empty string is not the same as
		// absent: it reaches the schema as `''` and fails `.min(1)`.
		const live = Array.from(read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm), (m) => m[1]);

		expect(live).toEqual(['DATABASE_URL']);
	});
});
