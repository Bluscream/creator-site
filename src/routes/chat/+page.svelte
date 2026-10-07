<!--
	The unified chat, on a page of its own.

	Replaces `main/chat/index.php`. Three things at once, as it was there:

	  - a chat window for anyone who would rather have it in its own tab;
	  - a browser source for OBS, with `?bg=transparent` and a font size;
	  - a page that can simply be linked to.

	Only the *unified* chat. The Twitch and Discord tabs in the PHP sidebar are iframes pointing at
	other people's sites, and they belong in the sidebar.

	### What it does and does not poll

	Nothing. The PHP refetched every four seconds per open tab; this fetches the backlog once and
	then holds one SSE connection. See `src/lib/live-feed.svelte.ts`.

	### Not ported yet, deliberately

	The PHP read each display setting from the query string, then from the chat's own `config.json`,
	then from a default. The middle step needs the admin and the database, so until stage 5 a URL
	parameter or the default applies — which is how an OBS source is configured anyway. Also absent
	for the same reason: the site wallpaper, the theme tokens built from the site's config, and the
	`?help=1` parameter reference, which should be generated from `chat-settings.ts` rather than
	written out a second time.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import ActivityRow from '#lib/components/ActivityRow.svelte';
	import ChatRow from '#lib/components/ChatRow.svelte';
	import { chatSettings } from '#lib/chat-settings.js';
	import { interleave, liveFeed } from '#lib/live-feed.svelte.js';
	import * as m from '#lib/paraglide/messages.js';

	/**
	 * Read once, at mount, and deliberately not reactive.
	 *
	 * Two of these — the limit and whether events are wanted — decide what the feed subscribes to
	 * and how much it keeps, and the feed opens one connection for its lifetime. Making them
	 * reactive would promise that editing the URL reconfigures a running stream, which it does not;
	 * a navigation remounts the page and that is the honest way to change them.
	 *
	 * Everything else here is pure display and could be reactive, but splitting one settings object
	 * into a reactive half and a fixed half to say so would cost more than it explains.
	 */
	const settings = chatSettings(page.url.searchParams);

	const feed = liveFeed({
		limit: settings.limit,
		events: settings.events,
		topics: settings.events ? ['chat', 'activity'] : ['chat']
	});

	onDestroy(feed.stop);

	const rows = $derived(
		settings.events ? interleave(feed.messages, feed.activity) : interleave(feed.messages, [])
	);

	const ordered = $derived(settings.order === 'newest' ? [...rows].reverse() : rows);
</script>

<svelte:head>
	<title>{m.chat_page_title()}</title>
	<!-- An OBS source and a side window are neither of them pages to index, and the settings live
	     in the query string, so this must never be cached as a static document. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main
	class="chat"
	data-background={settings.background}
	style:--chat-font-size={`${String(settings.fontSize)}px`}
>
	<div class="log" role="log" aria-live="polite" aria-label={m.chat_log_label()}>
		{#if !feed.ready}
			<p class="status">{m.common_loading()}</p>
		{:else if feed.unavailable}
			<p class="status">{m.chat_unavailable()}</p>
		{:else if ordered.length === 0}
			<p class="status">{m.chat_empty()}</p>
		{:else}
			{#each ordered as row (row.kind === 'message' ? row.message.id : row.entry.id)}
				{#if row.kind === 'message'}
					<ChatRow
						message={row.message}
						avatars={settings.avatars}
						badges={settings.badges}
						platform={settings.platform}
					/>
				{:else}
					<ActivityRow entry={row.entry} platform={settings.platform} />
				{/if}
			{/each}
		{/if}
	</div>
</main>

<style>
	.chat {
		font-size: var(--chat-font-size, 15px);
		height: 100dvh;
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		box-sizing: border-box;
	}

	/*
	 * The three background modes. `transparent` is the one an OBS browser source needs: it
	 * composites onto the scene behind it, so anything painted here would cover that scene.
	 *
	 * Every mode states its own ink. The page cannot inherit one: there is no site stylesheet here
	 * yet, and a mode that paints a dark surface while leaving the text colour to the browser gets
	 * near-black on near-black for any visitor whose browser is not in dark mode. That is invisible
	 * to whoever built it in a dark-mode browser — which is how it was nearly shipped.
	 */
	.chat[data-background='solid'] {
		background: var(--surface, #0b0e14);
		color: var(--ink, #e6edf3);
	}

	.chat[data-background='page'] {
		/*
		 * Follows the browser's own preference, since there is nothing else to follow yet. When the
		 * theme system lands (§11.6) this becomes the site's tokens.
		 *
		 * `color-scheme` is not optional here: `Canvas` and `CanvasText` resolve to the *light*
		 * system colours until an element opts in, so without it a dark-mode browser got a white
		 * page — which is what the first screenshot of this page actually showed. It also makes the
		 * scrollbar on the log match, which is visible in an OBS source.
		 */
		color-scheme: light dark;
		background: var(--surface, Canvas);
		color: var(--ink, CanvasText);
	}

	/*
	 * Transparent paints nothing, so the ink is the one thing it must still get right — the text is
	 * going over whatever the scene behind it happens to be. Light, because an overlay sits on
	 * gameplay far more often than on a white background, with a shadow so it survives the
	 * exceptions.
	 */
	.chat[data-background='transparent'] {
		background: transparent;
		color: var(--ink-overlay, #ffffff);
		text-shadow:
			0 1px 2px rgb(0 0 0 / 90%),
			0 0 6px rgb(0 0 0 / 60%);
	}

	.log {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		/* Anchors the log to the bottom, so a new message pushes the backlog up rather than
		   appearing below the fold — and does it without a scroll-position calculation on every
		   update, which is what the PHP had to do. */
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 0.1em;
		/* Keeps the view pinned to the newest message for a reader who is already at the bottom,
		   and leaves it alone for one who has scrolled up to read. Also the browser's job rather
		   than ours. */
		overflow-anchor: auto;
	}

	.status {
		color: var(--muted, #8b949e);
		margin: auto;
		text-align: center;
	}
</style>
