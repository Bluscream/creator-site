<!--
	The error page.

	SvelteKit's default is an unstyled English sentence and a status code, which is wrong on a site
	that exists in two languages and will exist in more. This is the whole of the error surface for
	now: a 404 reads one way, everything else reads the other.

	Two statuses rather than one per code deliberately. "That page does not exist" and "something
	went wrong at our end" are the only two things a visitor can act on differently — the first means
	check the address, the second means try again — and a page that distinguished 502 from 503 would
	be telling them about our problem rather than theirs.
-->
<script lang="ts">
	import { page } from '$app/state';
	import LocaleSwitch from '#lib/components/LocaleSwitch.svelte';
	import { resolve } from '$app/paths';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';

	const missing = $derived(page.status === 404);

	const title = $derived(missing ? m.error_not_found_title() : m.error_unexpected_title());
	const body = $derived(missing ? m.error_not_found_body() : m.error_unexpected_body());
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>

<main>
	<h1>{title}</h1>
	<p>{body}</p>

	<p>
		<!-- `localizeHref` rather than a bare path: a visitor who reached a German page should be
		     offered the German front page, not bounced to the base locale. -->
		<a href={localizeHref(resolve('/'), {})}>{m.nav_home()}</a>
	</p>

	<LocaleSwitch />
</main>

<style>
	main {
		max-width: 40rem;
		margin: 4rem auto;
		padding: 0 1rem;
		/* Nothing else sets a scheme yet, and an error page is exactly where a visitor should not
		   meet black-on-black. */
		color-scheme: light dark;
	}

	h1 {
		margin-bottom: 0.5rem;
	}
</style>
