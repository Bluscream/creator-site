/**
 * That the metrics page draws what it was given, and says what each number is.
 *
 * The admin e2e suite proves the guard closes this page to a stranger. It proves nothing about what
 * an admin then sees, and this is the one page in the project where a rendering bug shows somebody
 * a **wrong number** rather than a broken layout — a derived estimate rendered identically to a
 * platform's own figure is an invitation to quote the wrong one.
 *
 * So the assertions here are mostly about the caveats: that an incomplete figure says so, that a
 * derived one says where it came from, and that a follower total admits it counts a person once per
 * platform. The numbers themselves are formatted by `Intl`, which is not this project's code to
 * test; what is tested is that the right formatter is reached, because watch time in seconds is
 * unreadable and nobody would notice it was wrong.
 */

import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';
import type { MetricReading, MetricTotal, MetricsResult, PlatformMetrics } from '#lib/metrics.js';
import type { PostSourceKind } from '#lib/server/providers/posts-kinds.js';
import type { Principal } from '#lib/server/session.js';

/** A reading, with the parts a case does not care about filled in. */
function reading(overrides: Partial<MetricReading> = {}): MetricReading {
	return {
		kind: 'followers',
		window: 'now',
		value: 1234,
		origin: 'platform',
		complete: true,
		...overrides
	};
}

/** A total, likewise. */
function total(overrides: Partial<MetricTotal> = {}): MetricTotal {
	return {
		kind: 'followers',
		window: 'now',
		value: 1234,
		platforms: 1,
		complete: true,
		origins: ['platform'],
		...overrides
	};
}

/** One platform's block. */
function platform(overrides: Partial<PlatformMetrics> = {}): PlatformMetrics {
	return {
		platform: 'bluesky',
		label: 'Bluesky',
		readings: [reading()],
		ok: true,
		reason: null,
		...overrides
	};
}

/**
 * The page, rendered with the given result.
 *
 * `data` is built as a fully typed value and handed over with no cast, which took three attempts
 * and is worth the result: the page's props include the admin layout's data as well as its own, so
 * a test that casts past the type can render a page whose real props it is not providing. The
 * compiler asking for `principal` and the three `canSee*` flags is it pointing out that the layout
 * is part of this page's contract.
 */
function show(metrics: Partial<MetricsResult> = {}) {
	const data = {
		// The layout's half. An owner, because this page's own guard is `admin` and the only thing
		// the component does with the role is render the identity strip.
		principal: {
			userId: 'someone',
			name: 'Someone',
			avatarUrl: null,
			role: 'owner'
		} satisfies Principal,
		signOutTo: '/',
		canSeePeople: true,
		canSeeBackup: true,
		canSeeMetrics: true,

		// This page's half.
		metrics: {
			available: true,
			overall: [total()],
			platforms: [platform()],
			...metrics
		} satisfies MetricsResult,
		measured: ['bluesky'] satisfies readonly PostSourceKind[],
		planned: ['youtube'] satisfies readonly PostSourceKind[]
	};

	// `params` and `form` are SvelteKit's, and the page reads neither — but they are part of
	// `PageProps`, so they are supplied rather than cast away. That is the last of it: no cast
	// anywhere, and the props the component is handed are the props it declares.
	return render(Page, { data, params: {}, form: null });
}

describe('with nothing to show', () => {
	it('says so, rather than drawing empty rows', async () => {
		const page = show({ available: false, overall: [], platforms: [] });

		await expect.element(page.getByText(/Nothing to show yet/)).toBeInTheDocument();
	});
});

describe('the overall view', () => {
	it('shows the number, the metric and the period it covers', async () => {
		const page = show();

		await expect.element(page.getByText('1,234').first()).toBeInTheDocument();
		await expect.element(page.getByText('Followers').first()).toBeInTheDocument();
		await expect.element(page.getByText('right now').first()).toBeInTheDocument();
	});

	it('says a figure covers only what was read, when it does', async () => {
		const page = show({ overall: [total({ complete: false })] });

		await expect
			.element(page.getByText(/Covers only what this site has read/).first())
			.toBeInTheDocument();
	});

	it('says a figure was worked out here rather than reported', async () => {
		const page = show({ overall: [total({ origins: ['derived'] })] });

		await expect
			.element(page.getByText(/Worked out from the posts this site has fetched/).first())
			.toBeInTheDocument();
	});

	it('admits a follower total counts somebody twice, once more than one platform is in it', async () => {
		const page = show({ overall: [total({ platforms: 2 })] });

		await expect.element(page.getByText(/counted twice/).first()).toBeInTheDocument();
	});

	it('does not say that about a single platform, where it is not true', () => {
		const page = show({ overall: [total({ platforms: 1 })] });

		expect(page.getByText(/counted twice/).elements()).toHaveLength(0);
	});

	it('does not say it about a metric where people are not what is counted', () => {
		// Views are not people: two platforms' view counts add up without counting anybody twice,
		// and a caveat that is always shown is a caveat nobody reads.
		const page = show({ overall: [total({ kind: 'views', platforms: 3 })] });

		expect(page.getByText(/counted twice/).elements()).toHaveLength(0);
	});

	it('states a period length rather than leaving it as "a period"', async () => {
		const page = show({ overall: [total({ window: 'period', days: 28 })] });

		await expect.element(page.getByText('last 28 days').first()).toBeInTheDocument();
	});

	it('shows watch time in hours, because seconds are unreadable', async () => {
		// 1,409,922 seconds is a number nobody can use. Every platform's own dashboard says hours.
		const page = show({
			overall: [total({ kind: 'watch_time', value: 1_409_922 })],
			platforms: []
		});

		await expect.element(page.getByText('391.6 h').first()).toBeInTheDocument();
	});
});

describe('the per-platform view', () => {
	it('names the platform and draws its readings', async () => {
		const page = show();

		await expect.element(page.getByRole('heading', { name: 'Bluesky' })).toBeInTheDocument();
	});

	it('shows a platform’s own explanation of why it has no numbers', async () => {
		// For every platform but Bluesky today this sentence is the page's actual content, so
		// rendering it is not a nicety.
		const page = show({
			overall: [],
			platforms: [
				platform({
					label: 'YouTube',
					readings: [],
					ok: false,
					reason:
						'Reading numbers from this platform is not built yet — it will use the YouTube Analytics API.'
				})
			]
		});

		await expect
			.element(page.getByText(/it will use the YouTube Analytics API/))
			.toBeInTheDocument();
		await expect.element(page.getByText(/No numbers from this one yet/)).toBeInTheDocument();
	});

	it('marks a third-party number as somebody else’s', async () => {
		const page = show({
			overall: [],
			platforms: [platform({ readings: [reading({ origin: 'third_party' })] })]
		});

		await expect.element(page.getByText(/From a third party/)).toBeInTheDocument();
	});
});

describe('what it says about its own coverage', () => {
	it('counts the platforms that report their own numbers and the ones that do not', async () => {
		// Without this an install whose platforms are all unread looks broken rather than early.
		const page = show();

		await expect
			.element(page.getByText(/1 platform\(s\) report their own numbers; 1 are configured/))
			.toBeInTheDocument();
	});
});
