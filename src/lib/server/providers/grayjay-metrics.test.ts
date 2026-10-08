/**
 * Subscriber counts through the GrayJay plugins.
 *
 * The offline half tests routing and the handling of a count that is not one — which is where this
 * goes wrong quietly, because a `NaN` or a missing field turned into a zero is a number somebody
 * will read and believe.
 *
 * The offline half **cannot** test the thing that matters: that a real plugin, driven anonymously,
 * answers `getChannel` with a real number. That claim is the whole reason this file exists, and
 * only the live cases at the end check it. Set `RUN_LIVE=1`.
 *
 * ```sh
 * RUN_LIVE=1 npx vitest --run src/lib/server/providers/grayjay-metrics.test.ts
 * ```
 */

import { describe, expect, it } from 'vitest';
import { grayjayMetricsProvider, kickMetricsProvider } from './grayjay-metrics.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

const SOURCE: ResolvedSource = {
	id: 'grayjay',
	kind: 'grayjay',
	target: 'https://www.dailymotion.com/euronews-en',
	label: 'Dailymotion',
	platform: null
};

/** A context that reaches the network, for the live cases. */
function real(): SourceContext {
	return {
		fetch: (url, init) =>
			fetch(url, {
				...(init?.method === undefined ? {} : { method: init.method }),
				...(init?.headers === undefined ? {} : { headers: init.headers }),
				...(init?.body === undefined ? {} : { body: init.body })
			}),
		store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
	};
}

describe('deciding whether it can read a source at all', () => {
	it.each([
		['a Dailymotion channel', 'https://www.dailymotion.com/euronews-en'],
		['an Odysee channel', 'https://odysee.com/@Odysee:8'],
		[
			'a PeerTube channel on an instance nobody listed',
			'https://peertube.futo.org/video-channels/futo'
		]
	])('accepts %s', (_what, target) => {
		expect(grayjayMetricsProvider.unusable({ ...SOURCE, target })).toBeNull();
	});

	it('refuses a host no plugin reads, and lists the ones it does', () => {
		// The same advice the feed gives for the same target, because it is the same table — and an
		// admin who fixed the feed source should not then be told something different here.
		const refusal = grayjayMetricsProvider.unusable({ ...SOURCE, target: 'https://example.com/x' });

		expect(refusal).toMatch(/Set this source to a channel on one of/);
		expect(refusal).toMatch(/Dailymotion/);
	});

	it.each([
		['a bare handle', 'xqc'],
		['a handle with an at sign', '@xqc'],
		['a channel url', 'https://kick.com/xqc']
	])('accepts %s for Kick', (_what, target) => {
		expect(kickMetricsProvider.unusable({ ...SOURCE, kind: 'kick', target })).toBeNull();
	});

	it('gives Kick the same advice its feed reader does', () => {
		// Asserted because the string is now shared rather than copied: two sentences an admin reads
		// for the same mistake would drift, and which one they saw would depend on which page.
		expect(kickMetricsProvider.unusable({ ...SOURCE, kind: 'kick', target: 'not a handle!' })).toBe(
			'Set this source to a Kick channel, for example `kick.com/xqc` or just `xqc`.'
		);
	});
});

const live = process.env.RUN_LIVE === '1' ? describe : describe.skip;

live('against the real plugins', () => {
	// `getChannel` with no credential, which is the premise. Each of these is a long-standing
	// channel whose count is large enough that a zero would be a genuine failure rather than a
	// quiet channel — except PeerTube's, which is small and real, and is here because it is the
	// federated case the fixed-host table cannot cover.
	it.each([
		['Kick', 'xqc', 1000],
		['Dailymotion', 'https://www.dailymotion.com/euronews-en', 1000],
		['Odysee', 'https://odysee.com/@Odysee:8', 1000],
		['PeerTube', 'https://peertube.futo.org/video-channels/futo', 1]
	])(
		'%s reports a follower count',
		async (name, target, least) => {
			const provider = name === 'Kick' ? kickMetricsProvider : grayjayMetricsProvider;
			const readings = await provider.read(
				{ ...SOURCE, kind: name === 'Kick' ? 'kick' : 'grayjay', target, label: name },
				real()
			);

			expect(readings).toHaveLength(1);

			const [first] = readings;

			// Strict about the shape, because this is what reaches an arithmetic sum: a number that
			// is an integer, a window that is a snapshot, and a claim that the platform said it.
			expect(first?.kind).toBe('followers');
			expect(first?.window).toBe('now');
			expect(first?.origin).toBe('platform');
			expect(first?.complete).toBe(true);
			expect(Number.isInteger(first?.value)).toBe(true);
			expect(first?.value).toBeGreaterThanOrEqual(least);
		},
		240_000
	);

	it('says the channel does not exist, naming the platform', async () => {
		// A channel that does not exist, on a host that does. This case found a real bug: the
		// plugins answer `null` for a channel they cannot resolve, and that was being treated as
		// "no count published" — so a typo in a channel url left an empty platform block on the
		// page forever with nothing saying why. The message names the platform, because "the reader
		// failed" sends an admin to check the wrong thing.
		await expect(
			grayjayMetricsProvider.read(
				{
					...SOURCE,
					target: 'https://www.dailymotion.com/this-channel-does-not-exist-0a1b2c3d4e'
				},
				real()
			)
		).rejects.toThrow(/Dailymotion has no channel at that address/);
	}, 240_000);
});
