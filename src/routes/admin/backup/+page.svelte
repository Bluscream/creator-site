<!--
	Taking a backup, and restoring one.

	Two forms, deliberately far apart in weight. The download is one field and a button. The restore
	asks for a file, offers to *look* at it first, and only then offers to replace everything — with
	the confirmation on the destructive button and not on the harmless one.

	### Why "inspect" exists

	Because the alternative is that the only way to find out whether a file is the right backup is to
	restore it. An operator with three archives and no idea which is which should be able to ask,
	and asking changes nothing.

	### No JavaScript is required for either

	Both are ordinary form posts, and the download is a form that targets a route returning a file.
	This is the page somebody opens when the install is already broken, which is the worst possible
	moment for it to depend on anything.
-->
<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** The archive a restore would use, so the buttons can say whether one has been chosen. */
	let chosen = $state('');

	/**
	 * What to say about the last submission, in the page's language.
	 *
	 * A switch rather than a lookup keyed by the problem code, so each message is a call that
	 * `src/lib/i18n-coverage.test.ts` can see. A table would make every one of them look unused.
	 *
	 * `outcome` is the discriminant rather than `'done' in form`, because SvelteKit merges an
	 * action's success and failure shapes into one optional-everything type — so the `in` check
	 * narrowed nothing and every field stayed possibly-undefined.
	 */
	const notice = $derived.by(() => {
		if (form === null) return null;

		const outcome = form.outcome;

		if (outcome !== undefined) {
			return outcome.superseded === undefined
				? m.admin_backup_inspected({
						when: new Date(String(outcome.createdAt)).toLocaleString(),
						count: outcome.entries ?? 0
					})
				: m.admin_backup_restored({
						when: new Date(String(outcome.createdAt)).toLocaleString()
					});
		}

		switch (form.problem) {
			case 'wrong_password_or_corrupt':
				return m.admin_backup_wrong_password();
			case 'not_an_archive':
				return m.admin_backup_not_an_archive();
			case 'unsupported_format':
			case 'from_a_newer_build':
				return m.admin_backup_newer_build();
			case 'manifest_missing':
			case 'manifest_invalid':
				return m.admin_backup_no_manifest();
			case 'contents_do_not_match_manifest':
			case 'not_a_database':
				return m.admin_backup_damaged();
			case 'unexpected_entry':
			case 'unsafe_entry':
			case 'unsafe_member':
				return m.admin_backup_unexpected_contents();
			case 'too_large':
			case 'upload_too_large':
				return m.admin_backup_too_large();
			case 'no_file':
				return m.admin_backup_no_file();
			case 'no_password':
				return m.admin_backup_no_password();
			default:
				return m.admin_failed();
		}
	});

	/** Whether the last submission left the install changed, which decides the notice's tone. */
	const replaced = $derived(form?.outcome?.superseded !== undefined);
</script>

<svelte:head>
	<title>{m.admin_backup_title()}</title>
</svelte:head>

<h1>{m.admin_backup_title()}</h1>
<p>{m.admin_backup_lead()}</p>

{#if notice !== null}
	<p class="notice" class:changed={replaced} role="status">{notice}</p>
{/if}

<section>
	<h2>{m.admin_backup_download_title()}</h2>
	<p>{m.admin_backup_download_lead()}</p>

	<!-- Posts to a route rather than an action, because what comes back is a file. -->
	<form method="POST" action="/admin/backup/archive">
		<label>
			{m.admin_backup_password()}
			<input
				type="password"
				name="password"
				required
				minlength={data.minimumPassword}
				autocomplete="new-password"
			/>
		</label>
		<p class="hint">{m.admin_backup_password_hint({ count: data.minimumPassword })}</p>

		<button type="submit">{m.admin_backup_download()}</button>
	</form>
</section>

<section>
	<h2>{m.admin_backup_restore_title()}</h2>
	<p>{m.admin_backup_restore_lead()}</p>

	<form method="POST" enctype="multipart/form-data">
		<label>
			{m.admin_backup_file()}
			<input type="file" name="archive" accept=".crsbak" required bind:value={chosen} />
		</label>

		<label>
			{m.admin_backup_password()}
			<input type="password" name="password" required autocomplete="current-password" />
		</label>

		<div class="buttons">
			<!--
				The harmless one first and unguarded; the destructive one guarded. `formaction` so one
				file input serves both, which also means the two can never disagree about which archive
				they are talking about.
			-->
			<button type="submit" formaction="?/inspect" disabled={chosen === ''}>
				{m.admin_backup_inspect()}
			</button>

			<button
				type="submit"
				formaction="?/restore"
				class="destructive"
				disabled={chosen === ''}
				onclick={(event) => {
					if (!confirm(m.admin_backup_confirm())) event.preventDefault();
				}}
			>
				{m.admin_backup_restore()}
			</button>
		</div>
	</form>
</section>

<style>
	section {
		margin-block: 2rem;
		padding-block-start: 1rem;
		border-block-start: 1px solid var(--line, currentColor);
	}

	label {
		display: block;
		margin-block: 0.75rem;
	}

	input {
		display: block;
		margin-block-start: 0.25rem;
		max-width: 30rem;
		width: 100%;
	}

	.hint {
		margin-block: 0.25rem;
		font-size: 0.875rem;
		opacity: 0.8;
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	/* Not relying on colour alone: the destructive button is also the one with the confirmation. */
	.destructive {
		font-weight: 700;
	}

	.notice {
		padding: 0.5rem 0.75rem;
		border-inline-start: 4px solid currentColor;
	}

	.notice.changed {
		font-weight: 700;
	}
</style>
