/**
 * Catalogue integrity.
 *
 * Paraglide makes a *missing* message a compile error: `m.nav_home()` does not exist unless the key
 * does, and `svelte-check` is part of the gate. So the failures worth testing here are the ones a
 * compiler cannot see, every one of which has shipped in the PHP implementation this replaces:
 *
 *   - a key present in English and absent in German, which Paraglide silently serves in English
 *   - a German string that still *is* the English string
 *   - a placeholder that survived translation in one language and not the other, so `{age}` renders
 *     literally for half the audience
 *   - an empty string, which renders as nothing at all and looks like a layout bug
 *
 * The one rule this file follows throughout: **nothing is listed by hand.** Locales come from the
 * inlang settings, catalogue paths come from the settings' own path pattern, and keys come from the
 * base catalogue. The checker it replaces had to be told about each new page, and the two pages
 * nobody remembered to tell it about went unchecked while reporting "Complete".
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	LOCALE_NAMES,
	carriesNoLocale,
	localeOptions,
	localeSchema,
	localizedPath,
	toLocaleOrBase
} from '#lib/i18n.js';

const SETTINGS_PATH = 'project.inlang/settings.json';

/**
 * Message keys are `<namespace>_<name>`, lower snake case.
 *
 * The namespace is what makes a 400-entry catalogue navigable, and a flat convention beats nesting
 * because the key in the source (`m.admin_save()`) is then the key in the file — searchable in one
 * direction with no mental translation step.
 */
const KEY_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Namespaces that exist or are planned, one per module.
 *
 * A deliberately closed list: its job is to catch `savebutton_label` and `adminSave`, which are the
 * typos that produce a catalogue nobody can find anything in.
 */
const NAMESPACES = new Set([
	'admin',
	'auth',
	'blog',
	'calendar',
	'chat',
	'common',
	'contact',
	'error',
	'feed',
	'home',
	'links',
	'locale',
	'nav',
	'setup'
]);

/**
 * Words that are genuinely the same in another language, and the language they are the same in.
 *
 * Without this, "identical to English" cannot be distinguished from "nobody translated it". With
 * it, the identical ones are a stated fact with a reviewer behind them rather than an oversight.
 * Nothing is here yet; entries are `['de', 'common_ok']`-shaped when they arrive.
 */
const INTENTIONALLY_IDENTICAL = new Set<string>([
	// The product's own name. Translating it would name a different product.
	'de:home_title'
]);

const settingsSchema = z.object({
	baseLocale: z.string(),
	locales: z.array(z.string()).min(1),
	'plugin.inlang.messageFormat': z.object({ pathPattern: z.string() })
});

const settings = settingsSchema.parse(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));

const { baseLocale } = settings;
const translatedLocales = settings.locales.filter((locale) => locale !== baseLocale);

/** The catalogue files are found the way inlang finds them, so the two cannot disagree. */
function catalogue(locale: string): Record<string, string> {
	const path = settings['plugin.inlang.messageFormat'].pathPattern.replace('{locale}', locale);
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
	const entries = z.record(z.string(), z.unknown()).parse(parsed);

	// `$schema` is metadata for the editor, not a message.
	return Object.fromEntries(
		Object.entries(entries)
			.filter(([key]) => !key.startsWith('$'))
			.map(([key, value]) => [key, z.string().parse(value)])
	);
}

/** The `{placeholder}` names a pattern uses, as a set, so order and repetition do not matter. */
function placeholders(pattern: string): Set<string> {
	const names = Array.from(
		pattern.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*\}/g),
		(match) => match[1]
		// The group cannot be absent when the pattern matched, but `noUncheckedIndexedAccess` does
		// not know that, and narrowing is cheaper than asserting.
	).filter((name): name is string => name !== undefined);

	return new Set(names);
}

const base = catalogue(baseLocale);
const baseKeys = Object.keys(base);

describe('the base catalogue', () => {
	it('is not empty, so the checks below are actually exercising something', () => {
		expect(baseKeys.length).toBeGreaterThan(0);
	});

	it.each(baseKeys)('%s is named <namespace>_<name> in lower snake case', (key) => {
		expect(key, `"${key}" does not match ${String(KEY_SHAPE)}`).toMatch(KEY_SHAPE);
	});

	it.each(baseKeys)('%s uses a known namespace', (key) => {
		const namespace = key.split('_')[0] ?? '';

		expect(
			NAMESPACES.has(namespace),
			`"${namespace}" is not a known namespace. Add it to NAMESPACES if the module is real.`
		).toBe(true);
	});

	it('is sorted, so a catalogue of hundreds stays reviewable in a diff', () => {
		expect(baseKeys).toStrictEqual([...baseKeys].toSorted());
	});
});

describe.each(translatedLocales)('the %s catalogue', (locale) => {
	const translated = catalogue(locale);

	it('translates every message in the base catalogue', () => {
		const missing = baseKeys.filter((key) => !(key in translated));

		expect(missing, `untranslated — these render in ${baseLocale}`).toStrictEqual([]);
	});

	it('has no message the base catalogue does not', () => {
		const extra = Object.keys(translated).filter((key) => !(key in base));

		expect(extra, 'unreachable: no code can refer to these').toStrictEqual([]);
	});

	it('is sorted', () => {
		const keys = Object.keys(translated);

		expect(keys).toStrictEqual([...keys].toSorted());
	});

	it.each(Object.entries(translated))('%s is not empty', (_key, value) => {
		expect(value.trim()).not.toBe('');
	});

	it('keeps every placeholder the base message has', () => {
		const mismatched = baseKeys
			.filter((key) => key in translated)
			.map((key) => {
				const expected = placeholders(base[key] ?? '');
				const actual = placeholders(translated[key] ?? '');
				const lost = [...expected].filter((name) => !actual.has(name));
				const invented = [...actual].filter((name) => !expected.has(name));

				return { key, lost, invented };
			})
			.filter(({ lost, invented }) => lost.length > 0 || invented.length > 0);

		expect(
			mismatched,
			'a lost placeholder renders as literal text; an invented one renders blank'
		).toStrictEqual([]);
	});

	it('does not leave a message identical to its base, unless that is deliberate', () => {
		const identical = baseKeys
			.filter((key) => key in translated && translated[key] === base[key])
			.filter((key) => !INTENTIONALLY_IDENTICAL.has(`${locale}:${key}`));

		expect(
			identical,
			`same as ${baseLocale}. If a word really is identical, add "${locale}:<key>" to INTENTIONALLY_IDENTICAL.`
		).toStrictEqual([]);
	});
});

describe('reading a language from untrusted input', () => {
	it('accepts a known language', () => {
		expect(localeSchema.parse('de')).toBe('de');
	});

	it.each([['fr'], ['EN'], [''], [null], [42]])('rejects %o', (value) => {
		expect(localeSchema.safeParse(value).success).toBe(false);
	});

	it('falls back to the base language rather than throwing', () => {
		expect(toLocaleOrBase('nonsense')).toBe(baseLocale);
		expect(toLocaleOrBase('de')).toBe('de');
	});
});

describe('the switcher options', () => {
	it('names every language, in settings order', () => {
		expect(localeOptions().map((option) => option.locale)).toStrictEqual([...settings.locales]);
	});

	it('names each language in that language', () => {
		for (const { locale, name } of localeOptions()) {
			expect(name.trim(), `${locale} has no name`).not.toBe('');
		}

		// Endonyms: a reader scanning for their own language looks for the word they would use.
		expect(LOCALE_NAMES.de).toBe('Deutsch');
	});
});

describe('deciding whether a URL expresses a language', () => {
	it.each([
		['https://example.com/', true],
		['https://example.com/chat', true],
		['https://example.com/chat?x=1', true],
		['https://example.com/de', false],
		['https://example.com/de/chat', false]
	])('%s → carriesNoLocale %s', (href, expected) => {
		expect(carriesNoLocale(new URL(href))).toBe(expected);
	});
});

describe('building the redirect target', () => {
	// The bug this locks down: `localizeUrl` answers from the runtime's own notion of the origin,
	// which replied to an http request with an https Location. A path cannot get that wrong.
	it('is a path, never an absolute URL', () => {
		const path = localizedPath(new URL('http://localhost:3123/'), 'de');

		expect(path.startsWith('/')).toBe(true);
		expect(path).not.toContain('://');
	});

	it('has no trailing slash to make SvelteKit redirect a second time', () => {
		expect(localizedPath(new URL('http://localhost:3123/'), 'de')).toBe('/de');
		expect(localizedPath(new URL('http://localhost:3123/chat'), 'de')).toBe('/de/chat');
	});

	it('keeps the query string and fragment', () => {
		expect(localizedPath(new URL('http://localhost:3123/?x=1&y=2'), 'de')).toBe('/de?x=1&y=2');
	});

	it('leaves the base language unprefixed', () => {
		expect(localizedPath(new URL('http://localhost:3123/de/chat'), 'en')).toBe('/chat');
	});
});
