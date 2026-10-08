<!--
	How the channels are doing: everything together, then platform by platform.

	### The two views are the same numbers

	"Overall" is the per-platform readings added up, grouped by metric *and* window — adding an
	all-time view count to a 28-day one would produce a number that is not anything. So a platform
	reporting a window nothing else reports gets its own overall row rather than being folded into a
	wrong total. The split view below is where that becomes visible.

	### Every number says what it is

	A figure the platform reported and a figure worked out here from the posts this install happens
	to have fetched are not the same claim, and a page that renders them identically is inviting
	somebody to quote the wrong one in a sponsorship conversation. So an incomplete number is marked,
	a derived one is marked, and a total of follower counts says that it counts a person once per
	platform.

	Numbers are formatted in the page's language rather than with a hand-rolled "1.2k": `Intl` knows
	what a German reader expects and a template literal does not.
-->
<script lang="ts">
	import { METRICS } from '#lib/metrics.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { MetricKind, MetricReading, MetricTotal, MetricWindow } from '#lib/metrics.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * A metric's name in the page's language.
	 *
	 * A switch rather than a lookup table keyed by kind, so each message is a call that
	 * `src/lib/i18n-coverage.test.ts` can see. A table would make all eight look unused.
	 */
	function metricName(kind: MetricKind): string {
		switch (kind) {
			case 'followers':
				return m.metrics_followers();
			case 'subscribers':
				return m.metrics_subscribers();
			case 'views':
				return m.metrics_views();
			case 'likes':
				return m.metrics_likes();
			case 'comments':
				return m.metrics_comments();
			case 'posts':
				return m.metrics_posts();
			case 'watch_time':
				return m.metrics_watch_time();
			case 'live_viewers':
				return m.metrics_live_viewers();
			default:
				return kind;
		}
	}

	/** What period a reading covers, said in words. */
	function windowName(window: MetricWindow, days: number | undefined): string {
		switch (window) {
			case 'now':
				return m.metrics_window_now();
			case 'all_time':
				return m.metrics_window_all_time();
			default:
				return m.metrics_window_period({ count: days ?? 0 });
		}
	}

	/**
	 * The number, formatted for the viewer.
	 *
	 * Watch time is seconds and is unreadable as one: nobody wants to be told 1,409,922. Hours is
	 * the unit every platform's own dashboard uses for it.
	 */
	function amount(kind: MetricKind, value: number): string {
		const locale = getLocale();

		if (METRICS[kind].unit === 'seconds') {
			return m.metrics_hours({
				count: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 3600)
			});
		}

		return new Intl.NumberFormat(locale).format(value);
	}

	/** The caveats on one overall row, as a list of sentences. */
	function caveats(total: MetricTotal): readonly string[] {
		const notes: string[] = [];

		if (!total.complete) notes.push(m.metrics_partial());
		if (total.origins.includes('derived')) notes.push(m.metrics_derived());
		if (METRICS[total.kind].doubleCountsPeople && total.platforms > 1) {
			notes.push(m.metrics_double_counted());
		}

		return notes;
	}

	/** The caveats on one platform's reading. */
	function readingCaveats(reading: MetricReading): readonly string[] {
		const notes: string[] = [];

		if (!reading.complete) notes.push(m.metrics_partial());
		if (reading.origin === 'derived') notes.push(m.metrics_derived());
		if (reading.origin === 'third_party') notes.push(m.metrics_third_party());

		return notes;
	}
</script>

<svelte:head>
	<title>{m.metrics_title()}</title>
</svelte:head>

<h1>{m.metrics_title()}</h1>
<p>{m.metrics_lead()}</p>

{#if !data.metrics.available}
	<p class="notice" role="status">{m.metrics_none()}</p>
{:else}
	<section>
		<h2>{m.metrics_overall()}</h2>

		<ul class="totals">
			{#each data.metrics.overall as total (`${total.kind}-${total.window}-${String(total.days ?? '')}`)}
				<li>
					<span class="value">{amount(total.kind, total.value)}</span>
					<span class="name">{metricName(total.kind)}</span>
					<span class="window">{windowName(total.window, total.days)}</span>
					<span class="across">{m.metrics_across({ count: total.platforms })}</span>

					{#each caveats(total) as note (note)}
						<span class="caveat">{note}</span>
					{/each}
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>{m.metrics_by_platform()}</h2>

		{#each data.metrics.platforms as platform (platform.label)}
			<article>
				<h3>{platform.label}</h3>

				{#if platform.reason !== null}
					<!-- The provider's own sentence. For most platforms today this says what is coming. -->
					<p class="notice">{platform.reason}</p>
				{/if}

				{#if platform.readings.length === 0}
					<p class="quiet">{m.metrics_platform_none()}</p>
				{:else}
					<ul class="readings">
						{#each platform.readings as reading (`${reading.kind}-${reading.window}-${String(reading.days ?? '')}`)}
							<li>
								<span class="value">{amount(reading.kind, reading.value)}</span>
								<span class="name">{metricName(reading.kind)}</span>
								<span class="window">{windowName(reading.window, reading.days)}</span>

								{#each readingCaveats(reading) as note (note)}
									<span class="caveat">{note}</span>
								{/each}
							</li>
						{/each}
					</ul>
				{/if}
			</article>
		{/each}
	</section>
{/if}

<section>
	<h2>{m.metrics_coverage()}</h2>
	<p>{m.metrics_coverage_lead({ measured: data.measured.length, planned: data.planned.length })}</p>
</section>

<style>
	section {
		margin-block: 2rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.totals {
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.5rem 0.75rem;
		border-inline-start: 3px solid currentColor;
	}

	.value {
		font-size: 1.5rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.name {
		font-weight: 600;
	}

	.window,
	.across {
		font-size: 0.875rem;
		opacity: 0.8;
	}

	/* A caveat is a whole-width line under the number, so it is read rather than skimmed past. */
	.caveat {
		flex-basis: 100%;
		font-size: 0.8125rem;
		opacity: 0.9;
	}

	.quiet {
		opacity: 0.8;
	}

	.notice {
		padding: 0.5rem 0.75rem;
		border-inline-start: 4px solid currentColor;
	}

	article {
		margin-block: 1.25rem;
	}
</style>
