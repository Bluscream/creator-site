<!--
	A viewer's picture, or a lettered disc standing in for one.

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
	interface Props {
		name: string;
		src: string | null;
		/** The viewer's chat colour, used to tint the stand-in. */
		colour: string | null;
		size?: number;
	}

	let { name, src, colour, size = 24 }: Props = $props();

	let failed = $state(false);

	const initial = $derived((Array.from(name)[0] ?? '?').toUpperCase());
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
		style:color={colour ?? null}
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
