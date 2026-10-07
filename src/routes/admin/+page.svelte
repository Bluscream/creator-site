<!--
	The admin's front page.

	It says what works and what does not, which is the only useful thing a shell with no pages behind
	it can say. The alternative — a dashboard of empty cards — looks like the site is broken rather
	than unfinished.
-->
<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
</script>

<svelte:head>
	<title>{m.admin_title()}</title>
</svelte:head>

<h1>{m.admin_title()}</h1>
<p>{m.admin_lead()}</p>

<h2>{m.admin_nothing_here_title()}</h2>
<p>{m.admin_nothing_here_body()}</p>

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	h2 {
		margin-top: 2rem;
		font-size: 1.1rem;
	}
</style>
