<!--
	The sign-in page.

	Deliberately one screen with nothing on it but buttons. There is no form, no password field and
	no "forgot your password" link, because this site holds no passwords — a provider authenticates
	the person and hands back an id, which is the whole reason that design was chosen.

	### Why each button is a link and not a form

	Starting a sign-in changes nothing on this site: the only side effect is a short-lived cookie
	holding the `state` to compare on the way back. A link is therefore honest, works without
	JavaScript, and is what a browser will restore if the visitor goes back. Signing *out* is a
	`POST`, for the opposite reason.

	### `rel="nofollow"` on the buttons

	A crawler that follows one starts an OAuth flow, which at best wastes a request and at worst
	leaves a pending cookie in somebody's cache. Nothing here should be indexed either.
-->
<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.auth_sign_in_title()}</title>
	<!-- A sign-in page in search results helps nobody and invites probing. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main>
	<h1>{m.auth_sign_in_title()}</h1>

	{#if data.reason !== null}
		<!-- Text, never markup: this arrives in a URL anybody can write. -->
		<p class="reason" role="alert">{data.reason}</p>
	{/if}

	{#if data.providers.length === 0}
		<h2>{m.auth_unavailable_title()}</h2>
		<p>{m.auth_unavailable_body()}</p>
	{:else}
		<p>{m.auth_sign_in_lead()}</p>

		{#if data.claimable}
			<p class="claim">{m.auth_claimable()}</p>
		{/if}

		<ul>
			{#each data.providers as provider (provider.kind)}
				<li>
					<a
						class="provider"
						rel="nofollow"
						href="/auth/{provider.kind}/login?next={encodeURIComponent(data.next)}"
					>
						{m.auth_sign_in_with({ provider: provider.label })}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		max-width: 26rem;
		margin: 4rem auto;
		padding: 0 1rem;
		color-scheme: light dark;
	}

	h1 {
		margin-bottom: 0.5rem;
	}

	h2 {
		font-size: 1.1rem;
	}

	ul {
		list-style: none;
		margin: 1.5rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.provider {
		display: block;
		padding: 0.75rem 1rem;
		border: 1px solid;
		border-radius: 0.5rem;
		text-align: center;
		text-decoration: none;
		font-weight: 600;
		color: inherit;
	}

	.provider:hover,
	.provider:focus-visible {
		/* `AccentColor` and its pair are system colours, so this follows the platform's own accent
		   and stays legible in both schemes without a palette being invented here. */
		background: AccentColor;
		color: AccentColorText;
	}

	.reason {
		padding: 0.75rem 1rem;
		border: 1px solid;
		border-radius: 0.5rem;
	}

	.claim {
		font-size: 0.9rem;
		opacity: 0.8;
	}
</style>
