<!--
	The root layout.

	Deliberately almost empty. There is no site chrome yet — no header, no navigation — because the
	navigation is driven by the config document, and that is stage 8. What it does carry is the two
	things every page needs regardless of what is in it.

	### The alternate-language links

	`<link rel="alternate" hreflang>` in the head, which is the standards-defined way to say "this
	document also exists in these languages". It replaces a hidden `<div>` of anchors that was here
	so SvelteKit's crawler would find the localised routes — the hidden block worked for the crawler
	and was invisible to everyone and everything else, including search engines, which read exactly
	this instead.

	A reader switches language with `LocaleSwitch`, which is a real control on the pages that have
	one. These are for machines.
-->
<script lang="ts">
	import { page } from '$app/state';
	import favicon from '#lib/assets/favicon.svg';
	import { localizeHref, locales } from '#lib/paraglide/runtime.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />

	{#each locales as locale (locale)}
		<link rel="alternate" hreflang={locale} href={localizeHref(page.url.pathname, { locale })} />
	{/each}
</svelte:head>

{@render children()}
