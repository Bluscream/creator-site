<!--
	A message's resolved content: text, emotes, gifts, mentions and links.

	Synchra resolves each emote and gift to a CDN url server-side, so a segment is already drawable
	and nothing here makes a request to find out what one looks like. Every segment carries `text`,
	which is the alt text when there is an image and the content when there is not.

	Replaces `renderSegments()` in `assets/chat-core.js`. The imperative DOM building is what goes
	away; the four cases are the same four.

	### Third-party content, so two rules hold throughout

	- **`referrerpolicy="no-referrer"`** on every image. These urls belong to Twitch, TikTok and
	  YouTube CDNs, and the referrer would otherwise tell them which page a viewer is reading.
	- **A link is only ever `http(s)`**, checked here rather than trusted. `href` comes from a
	  message somebody typed, and this is the one place on a row that becomes clickable; `javascript:`
	  in that position is the whole reason the check exists.
-->
<script lang="ts">
	import type { Segment } from '#lib/chat.js';

	interface Props {
		segments: readonly Segment[];
		/** The plain-text fallback, for a message that arrived with no resolved segments. */
		text?: string;
	}

	let { segments, text = '' }: Props = $props();

	const isHttpUrl = (value: string | undefined): boolean =>
		value !== undefined && /^https?:\/\//.test(value);
</script>

{#if segments.length === 0}
	{text}
{:else}
	{#each segments as segment, index (index)}
		{#if (segment.kind === 'emote' || segment.kind === 'gift') && segment.imageUrl !== undefined}
			<img
				class="segment-image"
				class:animated={segment.animated === true}
				src={segment.imageUrl}
				alt={segment.text}
				title={segment.text}
				loading="lazy"
				referrerpolicy="no-referrer"
			/>
		{:else if segment.kind === 'link' && isHttpUrl(segment.href)}
			<a href={segment.href} target="_blank" rel="noopener noreferrer">
				{segment.text === '' ? segment.href : segment.text}
			</a>
		{:else if segment.kind === 'mention'}
			<span class="segment-mention">{segment.text}</span>
		{:else}
			<!--
				Everything else as plain text, including a `link` segment whose href did not pass the
				check: the text is still what was said, and dropping it would silently edit someone's
				message.
			-->
			{segment.text}
		{/if}
	{/each}
{/if}

<style>
	.segment-image {
		height: 1.4em;
		width: auto;
		vertical-align: text-bottom;
	}

	/* An animated emote is motion nobody asked for, and a busy chat can have several per row. */
	@media (prefers-reduced-motion: reduce) {
		.segment-image.animated {
			/* There is no way to pause an animated GIF or WebP from CSS, so this at least stops it
			   competing with the text for attention. */
			opacity: 0.85;
		}
	}

	.segment-mention {
		color: var(--accent, #6ea8fe);
		font-weight: 600;
	}
</style>
