<!--
	The language switcher.

	Replaces the hidden block of links the layout carried, which existed so that SvelteKit's crawler
	would find the localised versions of each page and which nobody could use.

	### Links, not a `<select>`

	They have to be real `<a href>`s pointing at the localised URL, for three reasons that a
	JavaScript-driven control gives up: the crawler and search engines follow them, so each language
	is a discoverable document; they work before hydration and without JavaScript at all; and the
	browser's own "open in new tab" does the obvious thing.

	Paraglide builds each href, so the URL shape — prefix, domain, whatever `urlPatterns` says —
	stays its business rather than being assumed here.

	`hreflang` is on each link because that is what tells a reader's browser, and a search engine,
	what it is pointing at. Without it a switcher is a row of two-letter words.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { LOCALE_NAMES } from '#lib/i18n.js';
	import { getLocale, localizeHref, locales } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';

	const current = $derived(getLocale());
</script>

<nav class="locales" aria-label={m.locale_switch_label()}>
	{#each locales as locale (locale)}
		{@const active = locale === current}

		<a
			href={localizeHref(page.url.pathname, { locale })}
			hreflang={locale}
			lang={locale}
			class:active
			aria-current={active ? 'true' : undefined}
		>
			<!-- The endonym: a reader looking for German is looking for "Deutsch", not for "German"
			     written in a language they do not read. -->
			{LOCALE_NAMES[locale]}
		</a>
	{/each}
</nav>

<style>
	.locales {
		display: flex;
		gap: 0.75rem;
		font-size: 0.875rem;
	}

	a {
		color: inherit;
		opacity: 0.7;
	}

	a:hover,
	a:focus-visible {
		opacity: 1;
	}

	.active {
		/* Not colour alone: the current language has to be apparent to a reader who cannot
		   distinguish the two colours, which is WCAG 1.4.1. */
		font-weight: 700;
		opacity: 1;
		text-decoration: underline;
	}
</style>
