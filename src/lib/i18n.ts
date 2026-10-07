/**
 * The project's language surface.
 *
 * Paraglide generates the machinery — `src/lib/paraglide/` is compiled output and is not edited.
 * This module is the small typed layer on top of it: the things the application needs that a
 * message compiler does not provide, namely how to *name* a language to a human and how to accept
 * one from somewhere untrusted.
 *
 * Nothing here maintains a list of languages. `locales` and `Locale` come from
 * `project.inlang/settings.json` via the compiler, so adding a language is one edit in one file and
 * everything downstream either follows or fails to compile. That is deliberate: the previous PHP
 * implementation had a translation checker that each new page had to be registered with by hand,
 * and the two pages nobody remembered to register went unchecked for months.
 */

import { z } from 'zod';
import {
	baseLocale,
	deLocalizeUrl,
	getTextDirection,
	isLocale,
	locales,
	localizeUrl
} from '#lib/paraglide/runtime.js';
import type { Locale } from '#lib/paraglide/runtime.js';

export { baseLocale, getTextDirection, isLocale, locales };
export type { Locale };

/**
 * How each language names itself.
 *
 * Endonyms, not English names: a reader looking for their own language scans for the word they
 * would use for it, so a German speaker looks for "Deutsch" and never for "German".
 *
 * Typed as a total record over `Locale`, so adding a language to the inlang settings turns this
 * into a compile error until it has a name. A language with no name in the switcher is the kind of
 * omission that ships.
 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
	en: 'English',
	de: 'Deutsch'
};

/**
 * A language as it may arrive from outside the application — a query parameter, a form field, a
 * stored preference, an API body.
 *
 * `isLocale` already answers the question; this wraps it as a schema so an untrusted language code
 * is parsed at the boundary with everything else, rather than being special-cased at each call.
 */
export const localeSchema = z.custom<Locale>(isLocale, {
	message: `Expected one of: ${locales.join(', ')}`
});

/**
 * The language to use, given something that may or may not be one.
 *
 * For the places where a bad value is not worth an error — a stale cookie, a hand-edited URL, a
 * link from an older version of the site. Falls back to English rather than throwing, because a
 * page in the wrong language is better than no page.
 */
export function toLocaleOrBase(value: unknown): Locale {
	return isLocale(value) ? value : baseLocale;
}

/**
 * Whether this URL's language is decided by the URL or left to the visitor's browser.
 *
 * The base locale is served unprefixed — `/` is English, `/de` is German — which keeps the English
 * URLs the site already has. The cost is that an unprefixed URL is indistinguishable from an
 * explicit request for English as far as the `url` strategy is concerned: it matches, so the
 * `preferredLanguage` strategy behind it is never consulted. That is what `handleBrowserLanguage`
 * in `hooks.server.ts` exists to correct.
 *
 * `deLocalizeUrl` strips a locale prefix when there is one, so a URL that survives it unchanged is
 * one in which the visitor expressed no language.
 */
export function carriesNoLocale(url: URL): boolean {
	return deLocalizeUrl(url).pathname === url.pathname;
}

/**
 * Where to send a visitor for the same page in another language.
 *
 * Deliberately a path and not an absolute URL. `localizeUrl` builds its result on the runtime's
 * notion of the origin, which is not the origin the request arrived on — it answered an `http`
 * request with an `https` Location — and behind a tunnel the only trustworthy answer is the one
 * SvelteKit already derived for `event.url`. A relative Location also cannot accidentally send a
 * visitor to another host.
 *
 * The trailing slash is dropped because SvelteKit canonicalises `/de/` to `/de` with a redirect of
 * its own, and one redirect is enough.
 */
export function localizedPath(url: URL, locale: Locale): string {
	const target = localizeUrl(url, { locale });
	const path = target.pathname.length > 1 ? target.pathname.replace(/\/$/, '') : target.pathname;

	return `${path}${target.search}${target.hash}`;
}

/** Every language, with its own name, in settings order. For a switcher. */
export function localeOptions(): readonly { readonly locale: Locale; readonly name: string }[] {
	return locales.map((locale) => ({ locale, name: LOCALE_NAMES[locale] }));
}
