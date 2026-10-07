<!--
	One row of the chat log.

	Ported from `messageRow()` in `assets/chat-core.js`. The structure is the same — platform mark,
	badges, author, content — and what the port adds is that each piece is its own component instead
	of forty lines of `createElement`.

	### The author link

	Synchra reports a handle, never a public page, so the *server* builds the profile url and leaves
	it null for a platform that has no public profiles. A null therefore renders a plain span rather
	than a link that goes nowhere. It is checked for `http(s)` again here, because this is the one
	part of the row that becomes clickable and the value came from a third party.

	### The notice label

	A gift renders as its image alone, so a notice row would otherwise read "Linus" followed by a
	picture and nothing else. The plain text goes beside it — "Linus 🎁 Rose" — which is also what
	is left if the image never loads. Only when there *is* an image: see `needsNoticeLabel`.
-->
<script lang="ts">
	import type { Utterance } from '#lib/chat.js';
	import Icon from '#lib/components/Icon.svelte';
	import MessageSegments from '#lib/components/MessageSegments.svelte';
	import ActorAvatar from '#lib/components/ActorAvatar.svelte';
	import { TEXT_CONTRAST, isHexColor, onLight } from '#lib/color.js';
	import { iconFor, platform as lookupPlatform } from '#lib/platforms.js';

	interface Props {
		message: Utterance;
		avatars?: boolean;
		badges?: boolean;
		platform?: boolean;
	}

	let { message, avatars = true, badges = true, platform = true }: Props = $props();

	const actor = $derived(message.author);

	const profile = $derived(
		actor.profileUrl !== undefined && /^https?:\/\//.test(actor.profileUrl)
			? actor.profileUrl
			: null
	);

	/** The speaker's badges, or none: a platform that has no badges at all omits the field. */
	const actorBadges = $derived(actor.badges ?? []);

	/**
	 * The platform's reading colour, set as a custom property on this row.
	 *
	 * The PHP emitted one `[data-platform]` CSS rule per platform and inlined the lot into every
	 * page. A row can simply ask the registry for its own, which means no generated stylesheet, no
	 * `{@html}` to inject it with, and no rules shipped for platforms this creator does not use.
	 *
	 * `tint` rather than `primary` because `primary` is the brand's own colour and several of them —
	 * YouTube red, Twitch purple — fail contrast against a dark page. `platforms.ts` works the tint
	 * out from the brand colour once, against a real contrast ratio.
	 *
	 * Null for a platform with no colour recorded, which leaves the mark in the surrounding ink
	 * rather than in a colour nobody chose.
	 */
	const tint = $derived(lookupPlatform(message.platform)?.tint ?? null);

	/**
	 * The viewer's own chat colour, in a form that reads on either theme.
	 *
	 * A viewer picks their colour on Twitch or TikTok against *that* platform's dark chat, so a
	 * light page gets pale yellow on white often enough to matter — and unlike a brand colour this
	 * is per-message and cannot be fixed in a registry.
	 *
	 * So both readings are emitted as custom properties and CSS picks, which is the same thing
	 * `platforms.ts` does with `tint`/`tintLight`. Against the text bar, not the glyph bar: this is
	 * a word somebody has to read, and 3:1 is the threshold for a mark.
	 *
	 * A colour that is not a plain hex is dropped rather than passed through. Synchra sends
	 * `#rrggbb`, but this value originates with a third party and ends up in a style attribute.
	 */
	const viewerColour = $derived(isHexColor(actor.colour ?? null) ? (actor.colour ?? null) : null);
	const viewerColourLight = $derived(
		viewerColour === null ? null : onLight(viewerColour, TEXT_CONTRAST)
	);

	/**
	 * Whether the notice's plain text needs repeating beside its segments.
	 *
	 * A gift usually renders as its image alone, so the row would otherwise read "Linus" and then a
	 * picture — hence the label. But when the gift arrives with no image, the segments *already*
	 * spell it out, and adding the label prints "sent Rose sent Rose".
	 *
	 * Found by looking at the rendered page rather than by reading the code, which is the only way
	 * this kind of thing is ever found.
	 */
	const needsNoticeLabel = $derived(
		message.notice !== null &&
			message.text !== '' &&
			message.parts.some((part) => part.imageUrl !== undefined)
	);
</script>

<div
	class="row"
	class:notice={message.notice !== null}
	data-platform={message.platform}
	data-kind={message.notice}
	style:--platform-ink={tint}
	style:--viewer-ink={viewerColour}
	style:--viewer-ink-light={viewerColourLight}
>
	{#if avatars}
		<!-- The checked colour, not the raw one: the stand-in disc's letter is text too. -->
		<ActorAvatar {actor} colour={viewerColour} />
	{/if}

	<div class="content">
		{#if platform}
			<span class="platform">
				<Icon name={iconFor({ platform: message.platform ?? undefined })} size={13} />
			</span>
		{/if}

		{#if badges && actorBadges.length > 0}
			<span class="badges">
				{#each actorBadges as badge, index (index)}
					{#if badge.imageUrl !== undefined}
						<img
							class="badge"
							src={badge.imageUrl}
							alt={badge.name}
							title={badge.name}
							loading="lazy"
							referrerpolicy="no-referrer"
						/>
					{/if}
				{/each}
			</span>
		{/if}

		{#if profile === null}
			<span class="author">{actor.name}</span>
		{:else}
			<a class="author" href={profile} target="_blank" rel="noopener noreferrer" title={profile}>
				{actor.name}
			</a>
		{/if}

		<span class="text" title={message.text === '' ? null : message.text}>
			<MessageSegments segments={message.parts} text={message.text} />
		</span>

		{#if needsNoticeLabel}
			<span class="notice-label">{message.text}</span>
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		align-items: baseline;
		gap: 0.4em;
		padding: 0.15em 0;
		/* `anywhere`, not `break-word`: a pasted url with no spaces in it is a real message and must
		   not widen the log past the window. */
		overflow-wrap: anywhere;
	}

	.notice {
		background: color-mix(in oklab, var(--accent, #6ea8fe) 12%, transparent);
		border-radius: 0.25em;
		padding: 0.25em 0.35em;
	}

	.content {
		min-width: 0;
	}

	.platform {
		/* `--platform-ink` is set on the row above, from the registry. No brand colour is written
		   here, and a platform with none recorded falls through to the surrounding ink rather than
		   to a colour nobody chose. */
		color: var(--platform-ink, currentColor);
		margin-inline-end: 0.25em;
	}

	.badges {
		display: inline-flex;
		gap: 0.15em;
		margin-inline-end: 0.25em;
		vertical-align: text-bottom;
	}

	.badge {
		height: 1.1em;
		width: auto;
	}

	.author {
		font-weight: 650;
		text-decoration: none;
		/* Falls through to the surrounding ink for a viewer with no colour, rather than to one
		   nobody chose. */
		color: var(--viewer-ink, currentColor);
	}

	@media (prefers-color-scheme: light) {
		.author {
			color: var(--viewer-ink-light, currentColor);
		}
	}

	.author::after {
		/* In the markup rather than between elements, so a copied row reads "name: message" and the
		   separator is never selectable on its own. */
		content: ':';
		color: var(--muted, #8b949e);
		font-weight: 400;
	}

	.text {
		margin-inline-start: 0.3em;
	}

	.notice-label {
		color: var(--muted, #8b949e);
		margin-inline-start: 0.3em;
	}
</style>
