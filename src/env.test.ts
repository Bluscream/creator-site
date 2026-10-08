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
import { parseAdminAccounts, parseAllowRegistration } from './env.js';

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

/**
 * Variables the *runtime* reads rather than this application.
 *
 * `adapter-node` reads `BODY_SIZE_LIMIT` itself, before any code here runs, so it cannot be
 * declared in `src/env.ts` — there would be nothing to read it — and it still has to be in
 * `.env.example`, because an install that leaves it at the default cannot accept a backup upload
 * and the failure says nothing about why.
 *
 * An explicit list rather than a loosened check: the point of the check below is that a line
 * somebody will set and expect to do something is worse than an absent one, and that argument is
 * just as true for a typo in this name. Adding an entry here is a claim that something reads it.
 */
const ADAPTER_VARIABLES: readonly string[] = ['BODY_SIZE_LIMIT'];

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
		const unknown = documented
			.filter((name) => !declared.includes(name) && !ADAPTER_VARIABLES.includes(name))
			.sort();

		expect(
			unknown,
			`in .env.example and neither declared in src/env.ts nor listed as an adapter variable:\n${unknown.join('\n')}`
		).toEqual([]);
	});

	it('documents every adapter variable it makes an exception for', () => {
		// The exception list is only sound while each entry is actually in the example file. An
		// entry for a variable nobody documents would silently widen the check above forever.
		expect(ADAPTER_VARIABLES.filter((name) => !documented.includes(name))).toEqual([]);
	});

	it('leaves the required variable set and the optional ones commented', () => {
		// The example has to work when copied to `.env` unedited, and it only does if exactly the
		// required variable is live. An optional one set to an empty string is not the same as
		// absent: it reaches the schema as `''` and fails `.min(1)`.
		const live = Array.from(read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm), (m) => m[1]);

		expect(live).toEqual(['DATABASE_URL']);
	});
});

/**
 * The two parsers in `env.ts` that are more than a `z.string()`.
 *
 * Imported as functions rather than exercised through `defineEnvVars`, for the reason given at the
 * top: what that returns at runtime is SvelteKit's business. These two are this project's own logic,
 * they decide who can administer the site, and every way they could go wrong is silent.
 */
describe('parseAdminAccounts', () => {
	it('is empty when nothing is set', () => {
		expect(parseAdminAccounts(undefined)).toStrictEqual([]);
	});

	it('is empty for an empty value', () => {
		// Which is what commenting the line out badly leaves behind.
		expect(parseAdminAccounts('')).toStrictEqual([]);
	});

	it('reads one entry', () => {
		expect(parseAdminAccounts('discord:1234567890')).toStrictEqual(['discord:1234567890']);
	});

	it('reads several, ignoring the spaces people leave after commas', () => {
		expect(parseAdminAccounts('discord:1234567890, google:98765')).toStrictEqual([
			'discord:1234567890',
			'google:98765'
		]);
	});

	it('lower-cases the entry so a comparison cannot miss on capitalisation', () => {
		expect(parseAdminAccounts('Discord:ABCdef')).toStrictEqual(['discord:abcdef']);
	});

	it.each([
		['a bare id with no provider', '1234567890'],
		['a provider with no id', 'discord:'],
		['an id with no provider', ':123'],
		['an email, which is not an id', 'someone@example.com'],
		['a username', 'discord:some one'],
		['a provider starting with a digit', '1discord:123'],
		['something with a comma inside it', 'discord:1;google:2 2']
	])('drops %s', (_, entry) => {
		// Dropped rather than kept: an entry nobody can match is a setting that quietly does nothing,
		// which is better than one that matches something unintended.
		expect(parseAdminAccounts(entry)).toStrictEqual([]);
	});

	it('keeps the good entries from a list with a bad one in it', () => {
		expect(parseAdminAccounts('discord:1234567890,nonsense')).toStrictEqual(['discord:1234567890']);
	});
});

describe('parseAllowRegistration', () => {
	it.each(['true', '1'])('is on for %s', (raw) => {
		expect(parseAllowRegistration(raw)).toBe(true);
	});

	it.each([
		['nothing set', undefined],
		['an empty value', ''],
		['yes', 'yes'],
		['on', 'on'],
		['TRUE, because a boolean should not be case-insensitive guesswork', 'TRUE'],
		['false', 'false'],
		['0', '0']
	])('is off for %s', (_, raw) => {
		// The safe reading of an unclear setting is the one that does not open registration.
		expect(parseAllowRegistration(raw)).toBe(false);
	});
});
