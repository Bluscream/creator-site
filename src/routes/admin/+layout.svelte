<!--
	The admin shell: who you are, where you can go, and how to leave.

	Thin on purpose. The navigation is one list and grows an entry per admin page, and there is no
	framework-shaped chrome around it yet because there is nothing yet to put inside. What it does
	settle is the two things every admin page needs and should not each solve: the identity strip, and
	a sign-out that cannot be triggered by anything but a deliberate press.

	### The sign-out is a form

	A `POST` to `/auth/sign-out`. On a `GET` it could be fired by an `<img>` on another site, a link
	preview or a prefetcher, and the creator would be signed out over and over with no way to tell
	why. As a form it also needs no JavaScript.

	### No avatar `referrerpolicy` lapse

	The picture is on the provider's CDN, so loading it tells them this page was opened.
	`referrerpolicy="no-referrer"` at least stops the admin's own URL going with it.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/**
	 * The navigation, filtered to what this person may actually open.
	 *
	 * Derived rather than a constant because the labels are message functions and the role decides
	 * which entries exist. `aria-current` matches on the *end* of the path, so a localised `/de/admin`
	 * is marked current too.
	 */
	const links = $derived([
		{ href: '/admin', label: m.admin_title() },
		{ href: '/admin/account', label: m.admin_nav_account() },
		...(data.canSeePeople ? [{ href: '/admin/people', label: m.admin_nav_people() }] : []),
		...(data.canSeeBackup ? [{ href: '/admin/backup', label: m.admin_nav_backup() }] : [])
	]);

	/**
	 * The role, in the page's language rather than as the database spelling.
	 *
	 * A switch rather than a lookup table keyed by role, so each message is a call rather than a
	 * reference — which is what `src/lib/i18n-coverage.test.ts` looks for when it reports a catalogue
	 * key nothing uses. A table would have made all five look dead.
	 */
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
				// `roleOf` should have made this unreachable. Showing the stored value is more useful
				// than showing nothing if it ever is not.
				return role;
		}
	}
</script>

<svelte:head>
	<!-- The admin is never a search result. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="shell">
	<header>
		<nav aria-label={m.nav_admin()}>
			{#each links as link (link.href)}
				<a
					href={localizeHref(link.href, {})}
					aria-current={page.url.pathname.endsWith(link.href) ? 'page' : undefined}
				>
					{link.label}
				</a>
			{/each}
		</nav>

		<div class="who">
			{#if data.principal.avatarUrl !== null}
				<img
					src={data.principal.avatarUrl}
					alt=""
					width="28"
					height="28"
					referrerpolicy="no-referrer"
				/>
			{/if}

			<span>
				<strong>{m.admin_signed_in_as({ name: data.principal.name })}</strong>
				<small>{m.admin_role({ role: roleName(data.principal.role) })}</small>
			</span>

			<form method="POST" action="/auth/sign-out">
				<input type="hidden" name="next" value={data.signOutTo} />
				<button type="submit">{m.auth_sign_out()}</button>
			</form>
		</div>
	</header>

	<main>
		{@render children()}
	</main>
</div>

<style>
	.shell {
		max-width: 60rem;
		margin: 0 auto;
		padding: 0 1rem;
		color-scheme: light dark;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 0;
		border-bottom: 1px solid;
	}

	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}

	nav a {
		color: inherit;
		font-weight: 600;
	}

	nav a[aria-current='page'] {
		text-decoration-thickness: 2px;
		text-underline-offset: 0.2em;
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.who span {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}

	.who img {
		border-radius: 50%;
	}

	small {
		opacity: 0.7;
	}

	main {
		padding: 1.5rem 0;
	}
</style>
