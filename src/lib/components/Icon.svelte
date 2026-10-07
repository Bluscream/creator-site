<!--
	One icon from the registry.

	This is the component the `Icons.php` port deliberately left to be written: `svg()` built an
	element as a string because PHP has no component model, and the registry is data. So the data
	lives in `icons.ts` and the drawing lives here, once, for every icon in the project.

	The two kinds differ in more than their paths. A stroke glyph is drawn with `fill="none"` and
	`stroke="currentColor"` so it takes the surrounding text colour; a brand mark is a single filled
	path and takes `fill="currentColor"` with no stroke at all. Drawing one with the other's
	attributes gives either an invisible mark or a smeared one, which is why `kind` exists.
-->
<script lang="ts">
	import { icon as lookup } from '#lib/icons.js';

	interface Props {
		/** A key from the icon registry. An unknown one falls back rather than drawing nothing. */
		name: string;
		/** Rendered size in pixels. The registry's grid is 24 regardless. */
		size?: number;
		/**
		 * What a screen reader should say.
		 *
		 * Omitted means decorative — the icon is hidden from the accessibility tree, which is right
		 * when it sits beside a label that already says the same thing. Most icons on this site are
		 * in that position, so decorative is the default.
		 */
		label?: string;
	}

	let { name, size = 16, label }: Props = $props();

	const drawing = $derived(lookup(name));
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	role={label === undefined ? 'presentation' : 'img'}
	aria-hidden={label === undefined ? 'true' : undefined}
	aria-label={label}
	fill={drawing.kind === 'brand' ? 'currentColor' : 'none'}
	stroke={drawing.kind === 'brand' ? undefined : 'currentColor'}
	stroke-width={drawing.kind === 'brand' ? undefined : 2}
	stroke-linecap={drawing.kind === 'brand' ? undefined : 'round'}
	stroke-linejoin={drawing.kind === 'brand' ? undefined : 'round'}
>
	{#if label !== undefined}
		<title>{label}</title>
	{/if}

	{#if drawing.kind === 'brand'}
		<path d={drawing.path} />
	{:else}
		{#each drawing.elements as [tag, attrs], index (index)}
			<!--
				A stroke glyph is a handful of primitives — `path`, `circle`, `line`, `rect` — and
				Svelte needs the tag named at compile time, so each is listed rather than built from
				the string. `svelte:element` would accept the string, but then every attribute would
				have to be spread untyped, and an unknown tag would render silently as a custom
				element instead of failing.
			-->
			{#if tag === 'path'}
				<path {...attrs} />
			{:else if tag === 'circle'}
				<circle {...attrs} />
			{:else if tag === 'line'}
				<line {...attrs} />
			{:else if tag === 'rect'}
				<rect {...attrs} />
			{:else if tag === 'polyline'}
				<polyline {...attrs} />
			{:else if tag === 'polygon'}
				<polygon {...attrs} />
			{:else if tag === 'ellipse'}
				<ellipse {...attrs} />
			{/if}
		{/each}
	{/if}
</svg>

<style>
	.icon {
		display: inline-block;
		flex: none;
		vertical-align: middle;
	}
</style>
