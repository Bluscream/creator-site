<!--
	An actor's picture, or a lettered disc standing in for one.

	Takes a canonical `Actor`, so the same component draws a chat message's speaker, a post's author
	and a supporter on a toast. It was `ViewerAvatar` and took three loose fields, which is why there
	was nearly a second one for posts.

	Not every message comes with a picture, and a blank makes the log look broken and knocks the
	rows out of alignment. So the initial is drawn instead, tinted with the viewer's own chat colour
	where they have one.

	The image is allowed to fail too — a CDN url does expire — in which case it is replaced by the
	same stand-in rather than leaving the browser's broken-image glyph in the log.

	Ported from `chatAvatar()` in `assets/chat-core.js`, including its one subtle detail: the initial
	is taken with `Array.from`, not `[0]`, because an emoji or any astral character is two code units
	and half of one renders as a replacement glyph. A viewer called 🖤Pauli is a real case.
-->
<script lang="ts">
	import type { Actor } from '#lib/canonical.js';

	interface Props {
		actor: Actor;
		/**
		 * The colour to tint the stand-in with, overriding the actor's own.
		 *
		 * A caller that has already checked the actor's colour — the chat row drops anything that is
		 * not a plain hex, because it ends up in a style attribute — passes the checked value rather
		 * than making this component check it a second time and disagree.
		 */
		colour?: string | null;
		size?: number;
	}

	let { actor, colour = null, size = 24 }: Props = $props();

	let failed = $state(false);

	const src = $derived(actor.avatarUrl ?? null);
	const tint = $derived(colour ?? actor.colour ?? null);
	const initial = $derived((Array.from(actor.name)[0] ?? '?').toUpperCase());
	const showImage = $derived(src !== null && src !== '' && !failed);
</script>

{#if showImage}
	<img
		class="avatar"
		{src}
		alt=""
		width={size}
		height={size}
		loading="lazy"
		referrerpolicy="no-referrer"
		onerror={() => {
			failed = true;
		}}
	/>
{:else}
	<span
		class="avatar avatar-initial"
		aria-hidden="true"
		style:width={`${String(size)}px`}
		style:height={`${String(size)}px`}
		style:color={tint}
	>
		{initial}
	</span>
{/if}

<style>
	.avatar {
		flex: none;
		border-radius: 50%;
		object-fit: cover;
	}

	.avatar-initial {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* A neutral disc, with the letter carrying the viewer's colour. Tinting the disc instead
		   would put their colour behind their own initial, and a viewer whose colour is dark would
		   get a dark letter on a dark disc. */
		background: var(--surface-raised, rgb(127 127 127 / 20%));
		font-size: 0.75em;
		font-weight: 700;
		line-height: 1;
	}
</style>
