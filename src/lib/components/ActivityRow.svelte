<!--
	A support event in the chat log: a donation, a sub, a gifted sub, a TikTok gift.

	Shown in the log so it is not lost to whoever had the panel open. Ported from `eventRow()` and
	`activityHeadline()` in `assets/chat-core.js`.

	### The money formatting is the browser's, not ours

	`Intl.NumberFormat` with `style: 'currency'` knows that €5.00 is "5,00 €" in German and "€5.00"
	in English, which symbol goes where, and which currencies have no minor units at all. The PHP
	version already did this; it is repeated here only because it is the one piece of logic on the
	row and it is worth being clear that it is not hand-rolled.

	The currency code arrives from a provider. A malformed one makes `Intl` throw, which would take
	the whole log down for one bad row — so it falls back to the bare number.
-->
<script lang="ts">
	import type { ActivityEntry } from '#lib/activity.js';
	import Icon from '#lib/components/Icon.svelte';
	import MessageSegments from '#lib/components/MessageSegments.svelte';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { iconFor, platform as lookupPlatform } from '#lib/platforms.js';

	interface Props {
		entry: ActivityEntry;
		platform?: boolean;
	}

	let { entry, platform = true }: Props = $props();

	function money(amount: number, currency: string, locale: string): string {
		try {
			return new Intl.NumberFormat(locale, {
				style: 'currency',
				currency,
				maximumFractionDigits: 2
			}).format(amount);
		} catch {
			// An unrecognised currency code from a provider must cost this row its symbol, not cost
			// the reader the whole log.
			return `${String(amount)} ${currency}`;
		}
	}

	/** "Ada — €5.00", "Linus — 3 diamonds", "Grace — Follow". */
	const headline = $derived.by(() => {
		const who = entry.actor.name;

		if (entry.currency !== null)
			return `${who} — ${money(entry.amount, entry.currency, getLocale())}`;

		if (entry.amount > 1 && entry.count_name !== '') {
			return `${who} — ${String(entry.amount)} ${entry.count_name}`;
		}

		return `${who} — ${entry.type_label === '' ? entry.type : entry.type_label}`;
	});

	const hasMessage = $derived(entry.message !== '' || entry.message_parts.length > 0);

	/** The platform's reading colour, from the registry. See the note in `ChatRow.svelte`. */
	const tint = $derived(lookupPlatform(entry.platform)?.tint ?? null);
</script>

<div class="row" data-platform={entry.platform} data-type={entry.type} style:--platform-ink={tint}>
	<div class="content">
		{#if platform}
			<span class="platform">
				<Icon name={iconFor({ platform: entry.platform ?? undefined })} size={13} />
			</span>
		{/if}

		<strong class="headline">{headline}</strong>

		{#if hasMessage}
			<span class="text">
				<MessageSegments segments={entry.message_parts} text={entry.message} />
			</span>
		{/if}
	</div>
</div>

<style>
	.row {
		padding: 0.3em 0.35em;
		border-inline-start: 3px solid var(--platform-ink, var(--accent, #6ea8fe));
		background: color-mix(in oklab, var(--platform-ink, #6ea8fe) 10%, transparent);
		border-radius: 0.25em;
		overflow-wrap: anywhere;
	}

	.content {
		min-width: 0;
	}

	.platform {
		color: var(--platform-ink, currentColor);
		margin-inline-end: 0.25em;
	}

	.text {
		margin-inline-start: 0.3em;
	}
</style>
