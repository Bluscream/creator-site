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
	import Icon from '#lib/components/Icon.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { iconFor, nameFor } from '#lib/platforms.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/**
	 * What a capability is called, in the page's language.
	 *
	 * A `switch` returning a call rather than a lookup table of functions, because the i18n coverage
	 * check reads *calls*: a table makes every message in it look dead, and the check then reports
	 * the catalogue as complete while six strings go unverified.
	 */
	function capabilityName(capability: string): string {
		switch (capability) {
			case 'sign-in':
				return m.admin_capability_sign_in();
			case 'posts':
				return m.admin_capability_posts();
			case 'chat':
				return m.admin_capability_chat();
			case 'live':
				return m.admin_capability_live();
			case 'activity':
				return m.admin_capability_activity();
			case 'social':
				return m.admin_capability_social();
			default:
				return capability;
		}
	}

	/** How a link was made, in the page's language. */
	function methodName(method: string): string {
		switch (method) {
			case 'token':
				return m.admin_linked_method_token();
			case 'login':
				return m.admin_linked_method_login();
			default:
				return m.admin_linked_method_oauth();
		}
	}

	/** The platform's own display name, falling back to the id for one the registry does not know. */
	function platformName(id: string): string {
		return nameFor({ platform: id }, id);
	}

	/** A unix-seconds timestamp, in whatever format the viewer's browser prefers. */
	function when(seconds: number): string {
		return new Date(seconds * 1000).toLocaleString();
	}

	/** How long a new token may be asked to live, in the page's language. */
	function lifetimeName(choice: string): string {
		switch (choice) {
			case '30d':
				return m.admin_token_valid_for_30d();
			case '90d':
				return m.admin_token_valid_for_90d();
			case '1y':
				return m.admin_token_valid_for_1y();
			default:
				return m.admin_token_valid_for_never();
		}
	}

	/**
	 * The token that was just created, or null.
	 *
	 * `$derived` of the form result rather than state this page keeps, which is what makes it
	 * disappear on the next action: a credential left on screen after the page has moved on is a
	 * credential somebody else reads over a shoulder. It is never put in `localStorage`, never in a
	 * URL, and nothing here logs it.
	 */
	const newToken = $derived(form !== null && 'token' in form ? form.token : null);
</script>

<svelte:head>
	<title>{m.admin_account_title()}</title>
</svelte:head>

<h1>{m.admin_account_title()}</h1>
<p>{m.admin_account_lead()}</p>

<!--
	Suppressed when a token was just created: that case has its own notice beside the credential, and
	a generic "Done" above it would be the first thing read and the less important of the two.
-->
{#if form !== null && newToken === null}
	<p class="notice" role="status">
		{#if 'error' in form}
			{m.admin_failed()}
		{:else if 'working' in form}
			<!--
				A check that ran is a successful action whatever it found, so the generic "Done" would
				report a link that cannot be used as a success — which is the one answer this button
				exists to give.
			-->
			{form.working ? m.admin_linked_checked_working() : m.admin_linked_checked_broken()}
		{:else}
			{m.admin_done()}
		{/if}
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
	<h2>{m.admin_linked_accounts()}</h2>
	<p>{m.admin_linked_accounts_lead()}</p>

	{#if data.connections.length === 0}
		<p><small>{m.admin_linked_none()}</small></p>
	{:else}
		<ul>
			{#each data.connections as connection (connection.id)}
				<li data-platform={connection.platform}>
					<span>
						<strong>
							<Icon name={iconFor({ platform: connection.platform })} size={14} />
							{connection.displayName ?? connection.handle ?? platformName(connection.platform)}
						</strong>
						<small>{methodName(connection.method)}</small>

						<!--
							Only the states worth acting on. A link that is fine says nothing, because a row
							of reassuring labels is a row nobody reads — and then the one that matters is
							not noticed either.
						-->
						{#if connection.expired}
							<small>{m.admin_linked_expired()}</small>
						{:else if connection.refreshable}
							<small>{m.admin_linked_renews()}</small>
						{/if}

						{#if connection.shown}
							<small>{m.admin_linked_shown()}</small>
						{/if}
					</span>

					<span class="actions">
						<form method="POST" action="?/showConnection" use:enhance>
							<input type="hidden" name="id" value={connection.id} />
							<!-- The state asked for, not a toggle: a double submission then lands where the
							     person meant rather than back where it started. -->
							<input type="hidden" name="shown" value={connection.shown ? 'false' : 'true'} />
							<button type="submit">
								{connection.shown ? m.admin_linked_hide() : m.admin_linked_show()}
							</button>
						</form>

						<!--
							Keyed by platform rather than by row id, because that is what renewing acts on:
							the credential for a platform, which is the newest link for it. The id is still
							what the row-scoped actions above use.
						-->
						<form method="POST" action="?/checkConnection" use:enhance>
							<input type="hidden" name="platform" value={connection.platform} />
							<button type="submit">{m.admin_linked_check()}</button>
						</form>

						<form method="POST" action="?/unlinkConnection" use:enhance>
							<input type="hidden" name="id" value={connection.id} />
							<button type="submit">{m.admin_linked_unlink()}</button>
						</form>
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#each data.platforms as platform (platform.id)}
		{@const linked = data.connections.some((entry) => entry.platform === platform.id)}

		<p>
			<!--
				A link, not a form: starting the round trip changes nothing here and the visitor is
				leaving for the platform's own site. `intent=connect` is what writes a credential row
				rather than another way of signing in.

				Offered even when already linked, because re-authorising is how a lapsed token is fixed
				and a button that disappeared after the first link would make the fix unfindable.
			-->
			<a rel="nofollow" href="/auth/{platform.id}/login?intent=connect&next=/admin/account">
				{linked
					? m.admin_relink_account({ platform: platform.label })
					: m.admin_link_account({ platform: platform.label })}
			</a>

			<small>
				{m.admin_linked_serves({
					capabilities: platform.capabilities.map((entry) => capabilityName(entry)).join(', ')
				})}
			</small>

			{#if platform.caveat !== null}
				<!-- The honest limitations the research turned up, shown where somebody is deciding
				     whether to link rather than discovered later as a feed that stays empty. -->
				<small>{platform.caveat}</small>
			{/if}
		</p>

		{#if platform.tokenHint !== null}
			<!--
				The escape hatch, in a `<details>` rather than beside the button: OAuth is the better
				route everywhere it works, and a visible paste field invites somebody to use it when
				they did not need to. `type="password"` so the credential is not left on screen, and
				`autocomplete="off"` so no password manager offers to keep it.
			-->
			<details>
				<summary>{m.admin_link_token({ platform: platform.label })}</summary>

				<form method="POST" action="?/linkToken" use:enhance>
					<input type="hidden" name="platform" value={platform.id} />

					<label>
						{m.admin_link_token_label()}
						<input
							type="password"
							name="token"
							required
							autocomplete="off"
							spellcheck="false"
							autocapitalize="off"
						/>
					</label>

					<small>{platform.tokenHint}</small>
					<small>{m.admin_link_token_warning()}</small>

					<button type="submit">{m.admin_link_token_submit()}</button>
				</form>
			</details>
		{/if}
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

<section>
	<h2>{m.admin_tokens()}</h2>
	<p>{m.admin_tokens_lead()}</p>

	{#if newToken !== null}
		<!--
			The one place in this project that puts a credential on screen. The sentence about it never
			being shown again is beside it rather than further down, because somebody who navigates away
			without copying it has to create another and the only way to prevent that is to say so where
			they are looking. `role="status"` so a screen reader is told it appeared.

			A `readonly` input rather than a `<code>` block, so the whole value selects with one click
			or one keyboard shortcut, and so the browser cannot re-wrap it into something that pastes
			with a line break in the middle.
		-->
		<p class="notice" role="status">{m.admin_token_once()}</p>

		<p class="secret">
			<input type="text" readonly value={newToken} spellcheck="false" />
		</p>

		<p><small>{m.admin_token_usage()}</small></p>
	{/if}

	{#if data.tokens.length === 0}
		<p><small>{m.admin_tokens_none()}</small></p>
	{:else}
		<ul>
			{#each data.tokens as token (token.id)}
				<li>
					<span>
						<strong>{token.name}</strong>

						<!-- The hint: a true prefix of the token, far too short to present, and the only
						     thing distinguishing two rows somebody gave the same name. -->
						<small><code>{token.hint}…</code></small>

						<small>
							{token.ability === 'write' ? m.admin_token_writes() : m.admin_token_read_only()}
						</small>

						<!--
							"Never used" is the state worth acting on: a token created, pasted wrong and
							forgotten is indistinguishable from a working one without it.
						-->
						<small>
							{token.lastUsedAt === null
								? m.admin_token_never_used()
								: m.admin_token_last_used({ when: when(token.lastUsedAt) })}
						</small>

						<small>
							{token.expiresAt === null
								? m.admin_token_never_expires()
								: m.admin_token_expires({ when: when(token.expiresAt) })}
						</small>

						<small>{m.admin_token_created({ when: when(token.createdAt) })}</small>
					</span>

					<span class="actions">
						<form method="POST" action="?/rotateToken" use:enhance>
							<!-- The row id, which is the token's hash. Not a credential; same reasoning as
							     the session rows above. -->
							<input type="hidden" name="id" value={token.id} />
							<button type="submit">{m.admin_token_rotate()}</button>
						</form>

						<form method="POST" action="?/revokeToken" use:enhance>
							<input type="hidden" name="id" value={token.id} />
							<button type="submit">{m.admin_token_revoke()}</button>
						</form>
					</span>
				</li>
			{/each}
		</ul>

		<p><small>{m.admin_token_rotate_note()}</small></p>

		<form method="POST" action="?/revokeAllTokens" use:enhance>
			<button type="submit">{m.admin_token_revoke_all()}</button>
		</form>
	{/if}

	<!--
		In a `<details>` because the common thing to do on this page is look at what already exists,
		and a form that is always open makes creating another look like the expected action.
	-->
	<details>
		<summary>{m.admin_token_new()}</summary>

		<form method="POST" action="?/createToken" use:enhance>
			<label>
				{m.admin_token_name()}
				<input type="text" name="name" required maxlength="60" autocomplete="off" />
			</label>
			<small>{m.admin_token_name_hint()}</small>

			<!--
				`read` first and pre-selected, because it is the right answer for nearly every program
				anybody will point at this, and a default should never be the dangerous one.
			-->
			<label>
				{m.admin_token_ability()}
				<select name="ability">
					<option value="read" selected>{m.admin_token_ability_read()}</option>
					<option value="write">{m.admin_token_ability_write()}</option>
				</select>
			</label>

			<label>
				{m.admin_token_valid_for()}
				<select name="lifetime">
					{#each data.lifetimes as choice (choice)}
						<option value={choice}>{lifetimeName(choice)}</option>
					{/each}
				</select>
			</label>

			<button type="submit">{m.admin_token_create()}</button>
		</form>
	</details>
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

	.actions {
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	li[data-platform] strong {
		display: flex;
		align-items: center;
		gap: 0.35em;
		/* From the platform registry, inlined on the row above. A platform with no colour recorded
		   falls through to the surrounding ink rather than to one nobody chose. */
		color: var(--platform-ink, inherit);
	}

	details {
		margin: 0.5rem 0 1rem;
	}

	details form {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	details label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
		max-width: 28rem;
	}

	details input {
		font: inherit;
		padding: 0.4rem 0.5rem;
	}

	.notice {
		padding: 0.75rem 1rem;
		border: 1px solid;
		border-radius: 0.5rem;
	}

	/* Monospace and full width, so the token is read and copied rather than squinted at. */
	.secret input {
		font-family: ui-monospace, monospace;
		font-size: 0.9rem;
		width: 100%;
		padding: 0.5rem;
	}

	details select {
		font: inherit;
		padding: 0.4rem 0.5rem;
	}

	code {
		font-size: 0.85em;
	}
</style>
