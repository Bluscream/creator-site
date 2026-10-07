<!--
	Your own account.

	Two lists and a handful of buttons. Everything is a real form posting to a named action, so the
	page works with no JavaScript at all — which is not a token gesture here: this is the page
	somebody reaches when something is already wrong, and "sign out everywhere" has to work on a
	borrowed browser with an extension blocking scripts.

	### `use:enhance` with nothing passed

	The default behaviour re-runs the page's `load` and applies the result, which is exactly right for
	these actions: every one of them changes a list this page is showing. Writing a custom handler
	would be writing that behaviour again, worse.

	### Dates are formatted by the browser

	`toLocaleString` with no locale argument, so a session's "last used" reads in the viewer's own
	format. The server sends unix seconds and no formatted string, which also keeps the server from
	having to know a timezone it cannot know.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A unix-seconds timestamp, in whatever format the viewer's browser prefers. */
	function when(seconds: number): string {
		return new Date(seconds * 1000).toLocaleString();
	}
</script>

<svelte:head>
	<title>{m.admin_account_title()}</title>
</svelte:head>

<h1>{m.admin_account_title()}</h1>
<p>{m.admin_account_lead()}</p>

{#if form !== null}
	<p class="notice" role="status">
		{'error' in form ? m.admin_failed() : m.admin_done()}
	</p>
{/if}

<section>
	<h2>{m.admin_sign_in_methods()}</h2>
	<p>{m.admin_sign_in_methods_lead()}</p>

	<ul>
		{#each data.identities as provider (provider)}
			<li>
				<span>{provider}</span>

				{#if data.canUnlink}
					<form method="POST" action="?/unlink" use:enhance>
						<input type="hidden" name="provider" value={provider} />
						<button type="submit">{m.admin_unlink()}</button>
					</form>
				{:else}
					<small>{m.admin_unlink_last()}</small>
				{/if}
			</li>
		{/each}
	</ul>

	{#each data.linkable as provider (provider.kind)}
		<!--
			A link rather than a form: starting a sign-in changes nothing here, and the visitor is
			leaving for the provider's own site. `intent=link` is what makes the identity attach to this
			account instead of signing in as it.
		-->
		<p>
			<a rel="nofollow" href="/auth/{provider.kind}/login?intent=link&next=/admin/account">
				{m.admin_add_sign_in({ provider: provider.label })}
			</a>
		</p>
	{/each}
</section>

<section>
	<h2>{m.admin_sessions()}</h2>
	<p>{m.admin_sessions_lead()}</p>

	<ul>
		{#each data.sessions as session (session.id)}
			<li>
				<span>
					{#if session.current}
						<strong>{m.admin_session_current()}</strong>
					{/if}
					<small>{m.admin_session_last_seen({ when: when(session.lastSeenAt) })}</small>
					<small>{m.admin_session_expires({ when: when(session.expiresAt) })}</small>
				</span>

				<form method="POST" action="?/endSession" use:enhance>
					<!-- The row id, which is the token's hash. It is not a credential; see the server file. -->
					<input type="hidden" name="id" value={session.id} />
					<button type="submit">{m.admin_end_session()}</button>
				</form>
			</li>
		{/each}
	</ul>

	{#if data.sessions.length > 1}
		<form method="POST" action="?/endOthers" use:enhance>
			<button type="submit">{m.admin_end_others()}</button>
		</form>
	{:else}
		<p><small>{m.admin_end_others_none()}</small></p>
	{/if}
</section>

<style>
	section {
		margin-top: 2rem;
	}

	h2 {
		font-size: 1.1rem;
		margin-bottom: 0.25rem;
	}

	ul {
		list-style: none;
		margin: 1rem 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid;
		border-radius: 0.5rem;
	}

	li span {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}

	small {
		opacity: 0.7;
	}

	.notice {
		padding: 0.75rem 1rem;
		border: 1px solid;
		border-radius: 0.5rem;
	}
</style>
