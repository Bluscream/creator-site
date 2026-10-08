/**
 * Any platform with a working GrayJay plugin, read through one reader.
 *
 * ### Why this exists as well as `kick`
 *
 * `kick` was written first, for a platform with no other route. Then the host library grew a DOM and
 * a `URL`, and the number of plugins that load and return real content went from two to forty-five —
 * at which point writing a reader per platform would have meant forty-three near-identical files.
 *
 * So the Kick-specific half (which spellings of a channel name to accept) stays in `kick-source.ts`,
 * and everything that was never Kick-specific lives here: driving the plugin, translating what it
 * returns, and routing requests through this project's own `fetch`. `kick` is now a thin wrapper
 * over {@link readThrough}, which is also the proof that this generalises — it is the same code path
 * that was already running live.
 *
 * ### What this does not do
 *
 * It does not accept an arbitrary plugin url from configuration. A manifest url in a config document
 * would mean an admin could point this at any JavaScript on the internet and have the server run it,
 * and "it is sandboxed" is not a good enough answer to that. {@link PLUGINS} is a fixed table of
 * plugins that have been loaded and checked, and a host outside it is reported as unsupported with
 * the list of what is.
 *
 * ### The costs, which are the same as `kick`'s
 *
 * A WebAssembly sandbox and two extra fetches per read, measured against the refresh interval
 * rather than against a page view. The plugin is fetched from its published url at run time and
 * never vendored, which is what keeps it current. The official plugins are AGPL-3.0; nothing here
 * redistributes one.
 */

import { loadPlugin } from 'grayjay-plugin-host';
import type { FetchLike } from 'grayjay-plugin-host';
import type { ContentPiece } from '../../posts.js';
import { buildPost } from './post.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/**
 * The plugins this reader will run, and the hosts each one reads.
 *
 * Every entry has been loaded and asked for real content. The list is deliberately not the whole
 * public index: of 112 runnable plugins, 45 return content, and most of the rest fail for reasons
 * outside anyone's control here — a manifest url that 404s, a platform that wants a login, a plugin
 * whose own regex QuickJS rejects. Listing one of those would mean offering a source that cannot
 * work.
 *
 * `hosts` is matched as a suffix on the hostname, so `odysee.com` covers `www.odysee.com`.
 */
export const PLUGINS: readonly {
	readonly name: string;
	readonly manifest: string;
	readonly hosts: readonly string[];
}[] = [
	{
		name: 'Dailymotion',
		manifest: 'https://plugins.grayjay.app/Dailymotion/DailymotionConfig.json',
		hosts: ['dailymotion.com', 'dai.ly']
	},
	{
		name: 'Odysee',
		manifest: 'https://plugins.grayjay.app/Odysee/OdyseeConfig.json',
		hosts: ['odysee.com']
	},
	{
		// Lower-case `c`, which the url does not forgive: `SoundcloudConfig.json`, not
		// `SoundCloudConfig.json`. Guessing it from the platform's own spelling gave a 404, and the
		// live test below is what caught it.
		name: 'SoundCloud',
		manifest: 'https://plugins.grayjay.app/Soundcloud/SoundcloudConfig.json',
		hosts: ['soundcloud.com']
	},
	{
		name: 'Nebula',
		manifest: 'https://plugins.grayjay.app/Nebula/NebulaConfig.json',
		hosts: ['nebula.tv']
	},
	{
		name: 'Bitchute',
		manifest: 'https://plugins.grayjay.app/Bitchute/BitchuteConfig.json',
		hosts: ['bitchute.com']
	},
	{
		// Not published through `plugins.grayjay.app`, which is ordinary: plenty of plugins in the
		// index are hosted by whoever wrote them.
		name: 'media.ccc.de',
		manifest:
			'https://raw.githubusercontent.com/PixelMelt/grayjay-source-ccc/master/MediaCCCConfig.json',
		hosts: ['media.ccc.de']
	}
];

// Deliberately absent from the table above, having been tried:
//
// - Rumble declares the `HttpImp` package, so the host refuses it by name. TLS fingerprint
//   impersonation needs a stack presenting a browser's exact ClientHello, which Node has not got,
//   so this one cannot be made to work here at any version.
// - PeerTube and Niconico load and negotiate a feed type but returned nothing for the channels
//   tried. A table entry is a claim that a platform can be read, and listing a plugin whose channel
//   reads come back empty would offer an admin a source that silently contributes nothing — the
//   exact failure this project goes out of its way to avoid everywhere else.
//
// Both are worth revisiting, PeerTube in particular: it is federated, so the right channel url may
// simply be a different shape than the one tried.

/** The plugin that reads a url's host, or null when none of them does. */
export function pluginFor(target: string): (typeof PLUGINS)[number] | null {
	let host;

	try {
		host = new URL(target.includes('://') ? target : `https://${target}`).hostname.toLowerCase();
	} catch {
		return null;
	}

	return (
		PLUGINS.find((plugin) =>
			plugin.hosts.some((entry) => host === entry || host.endsWith(`.${entry}`))
		) ?? null
	);
}

/** What an admin is told when no plugin reads the host they gave. */
export function advice(): string {
	return `Set this source to a channel on one of: ${PLUGINS.map((plugin) => plugin.name).join(', ')}.`;
}

/**
 * A unix-seconds timestamp from whichever field carries one.
 *
 * `datetime` is the documented field; `uploadDate` is the one Kick's plugin actually fills, and it
 * is not alone. Reading only the documented one dates every post to 1970, which sorts the whole
 * source to the bottom of a merged feed and reads as a broken site rather than a misread field.
 *
 * Zero counts as absent rather than as 1970, because that is what a plugin means by it.
 */
export function secondsOf(video: Record<string, unknown>): number | null {
	for (const key of ['datetime', 'uploadDate', 'publishDate', 'releaseDate'] as const) {
		const value = video[key];
		const seconds = typeof value === 'string' ? Number(value) : value;

		if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
			// Some plugins carry milliseconds. A value far beyond the present is the giveaway, and the
			// alternative — trusting it — dates posts tens of thousands of years from now, which sorts
			// them permanently to the top of the feed.
			return Math.round(seconds > 100_000_000_000 ? seconds / 1000 : seconds);
		}
	}

	return null;
}

/**
 * The best thumbnail among the ones offered.
 *
 * Highest `quality` wins, and a source with no quality at all counts as the lowest rather than
 * being dropped — several plugins emit a single unlabelled url, and discarding it costs the picture
 * for no gain.
 */
export function thumbnailOf(video: Record<string, unknown>): string | undefined {
	const thumbnails = video.thumbnails;
	const sources =
		typeof thumbnails === 'object' && thumbnails !== null
			? (thumbnails as { sources?: unknown }).sources
			: undefined;

	if (!Array.isArray(sources)) return undefined;

	let best: { url: string; quality: number } | null = null;

	for (const entry of sources as unknown[]) {
		if (typeof entry !== 'object' || entry === null) continue;

		const { url, quality } = entry as { url?: unknown; quality?: unknown };

		if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;

		const rank = typeof quality === 'number' && Number.isFinite(quality) ? quality : 0;

		if (best === null || rank > best.quality) best = { url, quality: rank };
	}

	return best?.url;
}

/**
 * The provider's own fetch, as the plugin host's.
 *
 * The reason this adapter exists rather than letting the library use the global `fetch`: this
 * project's provider contract says a source must go through `context.fetch`, which owns the user
 * agent, the redirect policy and the deadline. A reader that reached past it would opt out of all
 * three silently — and here it would do so for *somebody else's* code, which is worse.
 *
 * The library enforces its own allow-list, request budget and response cap **around** this, so what
 * arrives here has already been approved against the plugin's own manifest.
 *
 * A method other than GET or POST is refused by throwing. The library treats a throw as a transport
 * failure and hands the plugin a 504, so the plugin's own error path runs instead of the read dying.
 */
export function adapt(context: SourceContext): FetchLike {
	return (url, init) => {
		if (init.method !== 'GET' && init.method !== 'POST') {
			throw new Error(`this source does not perform ${init.method} requests`);
		}

		const headers: Record<string, string> = {};

		for (const [name, value] of init.headers.entries()) headers[name] = value;

		return context.fetch(url, {
			headers,
			...(init.method === 'POST' ? { method: 'POST' as const } : {}),
			...(init.body === undefined ? {} : { body: init.body })
		});
	};
}

/** One item from a plugin, as a post, or null when it is missing what a row needs. */
export function toPost(
	source: ResolvedSource,
	raw: unknown,
	fallback: { readonly author: string; readonly profileUrl?: string | undefined }
): ContentPiece | null {
	if (typeof raw !== 'object' || raw === null) return null;

	const video = raw as Record<string, unknown>;
	const url = typeof video.url === 'string' ? video.url : null;
	const id = (video.id as { value?: unknown } | undefined)?.value;
	const seconds = secondsOf(video);

	// A post with no url is not a row anybody can click, and one with no date cannot be ordered
	// against the other sources the page merges — so both are required rather than defaulted.
	if (url === null || seconds === null) return null;

	const author = video.author as { name?: unknown; url?: unknown } | undefined;
	const name = typeof author?.name === 'string' && author.name !== '' ? author.name : null;
	const profile = typeof author?.url === 'string' && author.url !== '' ? author.url : null;

	return buildPost(source, {
		// The plugin's own id where it has one, falling back to the url — which is unique per item
		// and stable, and is what the id is for.
		id: typeof id === 'string' && id !== '' ? id : url,
		kind: 'video',
		url,
		title: typeof video.name === 'string' ? video.name : null,
		image: thumbnailOf(video),
		publishedAt: new Date(seconds * 1000).toISOString(),
		author: name ?? fallback.author,
		authorProfileUrl: profile ?? fallback.profileUrl,
		views: typeof video.viewCount === 'number' ? video.viewCount : null,
		duration: typeof video.duration === 'number' ? video.duration : null,
		live: video.isLive === true
	});
}

/**
 * Loads a plugin, reads one channel through it, and translates the result.
 *
 * Shared by this provider and `kick`, which is what keeps the two honest: `kick` has been running
 * this path live since before it was generalised.
 *
 * @param label how to name the platform in a failure message — the plugin's name, which is what an
 *   admin recognises.
 */
export async function readThrough(
	source: ResolvedSource,
	context: SourceContext,
	options: {
		readonly manifest: string;
		readonly channel: string;
		readonly label: string;
		readonly author: string;
		readonly profileUrl?: string | undefined;
	}
): Promise<readonly ContentPiece[]> {
	const plugin = await loadPlugin(options.manifest, { fetch: adapt(context) }).catch(
		(cause: unknown) => {
			// The plugin, not the platform. Worth distinguishing, because an admin reading
			// "Kick is down" would go and check Kick — and this is the one failure here that is
			// neither theirs nor the platform's.
			throw new SourceFailure(
				`Could not load the ${options.label} reader (${cause instanceof Error ? cause.name : 'unknown error'}).`,
				{ cause }
			);
		}
	);

	try {
		const feed = await plugin.feed(options.channel);

		return feed.results
			.map((entry) =>
				toPost(source, entry, {
					author: options.author,
					...(options.profileUrl === undefined ? {} : { profileUrl: options.profileUrl })
				})
			)
			.filter((post): post is ContentPiece => post !== null);
	} catch (cause) {
		// The plugin's message is its own and may quote a url, so it is not passed through. The
		// orchestrator would replace a non-`SourceFailure` anyway; this says which platform it was.
		throw new SourceFailure(
			`Could not read ${options.label} channel ${options.author}. ${options.label} may have changed, or the channel may not exist.`,
			{ cause }
		);
	} finally {
		// Not optional: the sandbox holds a WASM heap until it is disposed.
		plugin.dispose();
	}
}

/** The name to show for a channel when the plugin does not give one: the last path segment. */
export function nameOf(target: string): string {
	try {
		const url = new URL(target.includes('://') ? target : `https://${target}`);
		const last = url.pathname.split('/').filter((part) => part !== '');

		return last[last.length - 1] ?? url.hostname;
	} catch {
		return target;
	}
}

export const grayjaySourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return pluginFor(source.target) === null ? advice() : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const plugin = pluginFor(source.target);

		if (plugin === null) throw new SourceFailure(advice());

		// The target is passed to the plugin unchanged. Plugins run their own `isChannelUrl` on it and
		// refuse anything they did not produce, so normalising it here would break channels that work
		// in the app.
		return readThrough(source, context, {
			manifest: plugin.manifest,
			channel: source.target.includes('://') ? source.target : `https://${source.target}`,
			label: plugin.name,
			author: nameOf(source.target)
		});
	}
};
