/**
 * Subscriber counts from the platforms read through GrayJay plugins.
 *
 * The second metrics reader that works with no credential at all, and by a distance the one with
 * the most reach: every plugin in `grayjay-source.ts`'s table answers `getChannel` with a
 * `subscribers` count, which was measured rather than assumed — Kick 1,129,228, Odysee 2,234,612,
 * Dailymotion 17,523, PeerTube 348, Niconico 9. One provider, nine platforms, and it works on a
 * fan's install exactly as it does on a creator's, because the plugins are driven anonymously.
 *
 * `origin: 'platform'`: a plugin reads the platform's own web app or API, so the number is the
 * platform's. Not `third_party` — the *plugin* is a third party, and the number is not.
 *
 * ### Why `subscribers` becomes `followers`
 *
 * GrayJay calls it `subscribers` because that is YouTube's word. Across this project's platforms it
 * is the "people who asked to be told when this creator posts" count — Kick's followers, Odysee's
 * followers, PeerTube's subscribers — which is {@link MetricKind} `followers`. `subscribers` in this
 * project's model means **paying** supporters, a number none of these report, so mapping a plugin's
 * `subscribers` onto it would put an audience count in the revenue column.
 *
 * ### The cost, stated plainly
 *
 * A read loads and runs the plugin: two fetches and the plugin's own `enable`, which for some of
 * them makes several more. That is the same cost the posts reader pays, and paying it twice per
 * refresh is why the metrics orchestrator caches for fifteen minutes rather than one.
 */

import { loadPlugin } from 'grayjay-plugin-host';
import { ADVICE as KICK_ADVICE, handleOf } from './kick-source.js';
import { adapt, advice, pluginFor } from './grayjay-source.js';
import { SourceFailure } from './posts-source.js';
import type { MetricReading } from '../../metrics.js';
import type { MetricsSourceProvider } from './metrics-source.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

/**
 * A channel's reported subscriber count, through a plugin.
 *
 * Shared by both providers below because the only thing that differs between them is how a target
 * becomes a manifest and a channel url.
 */
async function countFor(
	context: SourceContext,
	options: { readonly manifest: string; readonly channel: string; readonly label: string }
): Promise<readonly MetricReading[]> {
	const plugin = await loadPlugin(options.manifest, { fetch: adapt(context) }).catch(
		(cause: unknown) => {
			// The plugin, not the platform. An admin reading "Kick is down" would go and check Kick,
			// and this is the one failure here that is neither theirs nor the platform's.
			throw new SourceFailure(
				`Could not load the ${options.label} reader (${cause instanceof Error ? cause.name : 'unknown error'}).`,
				{ cause }
			);
		}
	);

	try {
		const channel = (await plugin.call('getChannel', [options.channel])) as {
			subscribers?: unknown;
		} | null;

		// `null` is the plugins' answer for a channel that does not exist — measured, not assumed:
		// Dailymotion returns exactly that for a made-up handle. Worth distinguishing from "no count
		// published", because the first is a typo an admin can fix and the second is nothing to do,
		// and collapsing them leaves a platform block permanently empty with no explanation.
		if (channel === null || typeof channel !== 'object') {
			throw new SourceFailure(`${options.label} has no channel at that address.`);
		}

		const count = channel.subscribers;

		// Absent, or not a number, means the plugin had nothing to say — not that nobody follows.
		// `Number.isInteger` rather than `typeof === 'number'` because a plugin that returns `NaN`
		// for a count it could not parse would otherwise put `NaN` into a sum.
		if (!Number.isInteger(count) || (count as number) < 0) return [];

		return [
			{
				kind: 'followers',
				// A snapshot. The platform does not say when it was true, and it is true now.
				window: 'now',
				value: count as number,
				origin: 'platform',
				complete: true
			}
		];
	} catch (cause) {
		if (cause instanceof SourceFailure) throw cause;

		// The plugin's own message is its own and may quote a url, so it is not passed through.
		throw new SourceFailure(
			`Could not read the ${options.label} channel. ${options.label} may have changed, or the channel may not exist.`,
			{ cause }
		);
	} finally {
		// Not optional: the sandbox holds a WASM heap until it is disposed.
		plugin.dispose();
	}
}

/** Any platform in the plugin table, addressed by a channel url. */
export const grayjayMetricsProvider: MetricsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return pluginFor(source.target) === null ? advice() : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly MetricReading[]> {
		const plugin = pluginFor(source.target);

		if (plugin === null) throw new SourceFailure(advice());

		return countFor(context, {
			manifest: plugin.manifest,
			channel: source.target,
			label: plugin.name
		});
	}
};

/** Kick's own plugin, which the feed reads too. */
const KICK_MANIFEST = 'https://plugins.grayjay.app/Kick/KickConfig.json';

/**
 * Kick, which keeps its own kind because a handle is what somebody has to hand for it.
 *
 * Here rather than in `kick-source.ts` so that everything driving a plugin for *numbers* is in one
 * file: the two providers share `countFor`, and splitting them would mean two copies of the plugin
 * lifecycle and the two failure messages that go with it.
 */
export const kickMetricsProvider: MetricsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? KICK_ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly MetricReading[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(KICK_ADVICE);

		return countFor(context, {
			manifest: KICK_MANIFEST,
			channel: `https://kick.com/${encodeURIComponent(handle)}`,
			label: 'Kick'
		});
	}
};
