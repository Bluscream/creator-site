<!--
	Who has an account, and what they may do.

	A list rather than a table, because the useful unit is a person and a table of five columns on a
	phone is a horizontal scrollbar. Each row is its own form: a single form with a row of selects
	would submit every row's role on every change, which is a lot of writes and an easy way to undo
	somebody else's edit by accident.

	Your own row has no control. That is `setRole` refusing, surfaced as a sentence rather than as a
	button that fails — a one-click irreversible self-demotion is exactly the mistake worth designing
	out, and the owner is the one person nobody else can put back.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** A unix-seconds timestamp, in whatever format the viewer's browser prefers. */
	function when(seconds: number): string {
		return new Date(seconds * 1000).toLocaleDateString();
	}

	/** The role, in the page's language. A switch so each message is a call; see the admin layout. */
	function roleName(role: string): string {
		switch (role) {
			case 'owner':
				return m.admin_role_owner();
			case 'admin':
				return m.admin_role_admin();
			case 'editor':
				return m.admin_role_editor();
			case 'moderator':
				return m.admin_role_moderator();
			case 'member':
				return m.admin_role_member();
			default:
				return role;
		}
	}

	/** What to say about a refused change, in the page's language. */
	const message = $derived.by(() => {
		if (form === null) return null;
		if (!('error' in form)) return m.admin_done();

		switch (form.error) {
			case 'last_owner':
				return m.admin_people_last_owner();
			case 'yourself':
				return m.admin_people_yourself();
			default:
				return m.admin_failed();
		}
	});
</script>

<svelte:head>
	<title>{m.admin_people_title()}</title>
</svelte:head>

<h1>{m.admin_people_title()}</h1>
<p>{m.admin_people_lead()}</p>

{#if message !== null}
	<p class="notice" role="status">{message}</p>
{/if}

<ul>
	{#each data.people as person (person.userId)}
		<li>
			<span class="who">
				{#if person.avatarUrl !== null}
					<!-- Somebody else's CDN, so no referrer goes with the request. -->
					<img src={person.avatarUrl} alt="" width="32" height="32" referrerpolicy="no-referrer" />
				{/if}

				<span>
					<strong>{person.name}</strong>
					<small>{m.admin_people_since({ when: when(person.createdAt) })}</small>
					<small>{person.providers.join(', ')}</small>
				</span>
			</span>

			{#if person.userId === data.you}
				<span class="role">
					<strong>{roleName(person.role)}</strong>
					<small>{m.admin_people_yourself()}</small>
				</span>
			{:else}
				<form method="POST" use:enhance>
					<input type="hidden" name="userId" value={person.userId} />

					<label>
						<span class="label">{m.admin_people_role()}</span>
						<select name="role" value={person.role}>
							{#each data.roles as role (role)}
								<option value={role}>{roleName(role)}</option>
							{/each}
						</select>
					</label>

					<button type="submit">{m.admin_people_save_role()}</button>
				</form>
			{/if}
		</li>
	{/each}
</ul>

<style>
	ul {
		list-style: none;
		margin: 1.5rem 0;
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
		gap: 1rem;
		padding: 0.75rem;
		border: 1px solid;
		border-radius: 0.5rem;
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.who span,
	.role {
		display: flex;
		flex-direction: column;
		line-height: 1.3;
	}

	img {
		border-radius: 50%;
	}

	form {
		display: flex;
		align-items: end;
		gap: 0.5rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.label {
		font-size: 0.8rem;
		opacity: 0.7;
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
