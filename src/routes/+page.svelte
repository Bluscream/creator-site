<!--
	The front page.

	A placeholder, and openly so. The real one is the links page — the creator's name, avatar and
	buttons, all driven by configuration — and that needs the config document and the admin, which
	are stage 8 and stage 5. What it replaces is the SvelteKit scaffold's "Welcome to SvelteKit",
	which was four untranslated English strings sitting in a project whose first rule is that every
	visible string goes through a message function. The check that now enforces that rule is what
	found them.

	So this says what the install is and points at the one page that works, in both languages.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import LocaleSwitch from '#lib/components/LocaleSwitch.svelte';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';
</script>

<svelte:head>
	<title>{m.home_title()}</title>
	<meta name="description" content={m.home_lead()} />
</svelte:head>

<main>
	<h1>{m.home_title()}</h1>
	<p>{m.home_lead()}</p>

	<p>
		<a href={localizeHref(resolve('/chat'), {})}>{m.nav_chat()}</a>
	</p>

	<LocaleSwitch />
</main>

<style>
	main {
		max-width: 40rem;
		margin: 4rem auto;
		padding: 0 1rem;
		/* As on the error page: nothing else sets a scheme yet, and the default `Canvas` colours
		   stay light until something opts in. */
		color-scheme: light dark;
	}

	h1 {
		margin-bottom: 0.5rem;
	}
</style>
