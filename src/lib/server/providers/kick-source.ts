/**
 * Kick, read through its GrayJay plugin.
 *
 * ### Why a plugin and not an API
 *
 * Kick publishes no documented public API for a channel's past broadcasts, and its own web client
 * calls an endpoint fronted by Cloudflare that answers a plain request with a challenge page. The
 * route that works is the one the GrayJay app uses, and the reason to borrow it rather than
 * reimplement it is that it is **maintained by people who watch Kick change** — which is the whole
 * argument for this kind of source, and the thing a hand-written scraper here could not match.
 *
 * So this provider owns no Kick knowledge at all. It loads `grayjay-plugin-host` — a library
 * extracted from this project's own research, published separately because it is useful to anyone
 * on Node and has nothing to do with this site — and asks the official Kick plugin for a channel's
 * content.
 *
 * ### What that costs, stated plainly
 *
 * - **A WebAssembly sandbox per read.** The plugin is third-party JavaScript; it runs in QuickJS
 *   compiled to WASM with no Node globals and no network except through {@link adapt} below. The
 *   sandbox is built and disposed inside {@link read}, because a long-lived one would hold a heap
 *   between refreshes for a provider that is asked for one page every few minutes.
 * - **Two extra fetches per read**, for the plugin's manifest and script. Measured against the
 *   refresh interval rather than against a request, since the orchestrator reads on a timer.
 * - **An AGPL plugin.** The host library is MIT and loading a plugin at run time does not make this
 *   site a derivative of it, but nothing here redistributes the plugin — it is fetched from Kick's
 *   own published url at run time, which is also why it stays current.
 *
 * ### Two things the plugin does that would be bugs if assumed
 *
 * 1. **The date is not where the interface says.** A Kick video leaves the documented `datetime` at
 *    `0` and puts unix seconds in `uploadDate`. Reading only `datetime` yields a feed where every
 *    post is dated 1970 and sorts to the bottom — which looks like a broken site rather than a
 *    misread field. Both are read, which is what {@link secondsOf} is for.
 * 2. **The feed type has to be negotiated rather than chosen**, and the plugin's own declared
 *    capabilities cannot be trusted. That is the library's problem and it is why this calls
 *    `plugin.feed` instead of `getChannelContents` directly.
 */

import { loadPlugin } from 'grayjay-plugin-host';
import type { FetchLike } from 'grayjay-plugin-host';
import type { ContentPiece } from '../../posts.js';
import { buildPost } from './post.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/** The official plugin, from Kick's own published url. Never vendored — see the module comment. */
const MANIFEST = 'https://plugins.grayjay.app/Kick/KickConfig.json';

/**
 * What a source's `target` may be.
 *
 * A Kick channel is a single path segment, so this accepts the handle on its own, with a leading
 * `@`, or as any `kick.com` url containing it — because all three are what somebody has to hand,
 * and rejecting two of them would be a configuration error for no reason.
 */
const HANDLE = /^[A-Za-z0-9_]{2,30}$/;

const ADVICE = 'Set this source to a Kick channel, for example `kick.com/xqc` or just `xqc`.';

/** The channel handle in `target`, or null when there is not one. */
export function handleOf(target: string): string | null {
	const trimmed = target.trim().replace(/^@/, '');

	if (HANDLE.test(trimmed)) return trimmed;

	let url;

	try {
		url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}

	if (!/(^|\.)kick\.com$/i.test(url.hostname)) return null;

	const first = url.pathname.split('/').find((part) => part !== '');

	return first !== undefined && HANDLE.test(first) ? first : null;
}

/**
 * A unix-seconds timestamp from whichever field carries one.
 *
 * `datetime` is the documented field and `uploadDate` is the one Kick's plugin actually fills — see
 * item 1 in the module comment. Zero counts as absent rather than as 1970, because that is what the
 * plugin means by it.
 */
export function secondsOf(video: Record<string, unknown>): number | null {
	for (const key of ['datetime', 'uploadDate'] as const) {
		const value = video[key];
		const seconds = typeof value === 'string' ? Number(value) : value;

		if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
			return Math.round(seconds);
		}
	}

	return null;
}

/**
 * The best thumbnail among the ones offered.
 *
 * Highest `quality` wins, and a source with no quality at all counts as the lowest rather than
 * being dropped — several plugins emit a single unlabelled url, and discarding it would cost the
 * picture for no gain.
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
 * arrives here has already been approved against the plugin's manifest.
 *
 * A method other than GET or POST is refused by throwing. The library treats a throw as a transport
 * failure and hands the plugin a 504, so the plugin's own error path runs instead of the read dying
 * — and the Kick plugin only ever does the two.
 */
function adapt(context: SourceContext): FetchLike {
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

/** One video from the plugin, as a post, or null when it is missing what a row needs. */
function toPost(source: ResolvedSource, handle: string, raw: unknown): ContentPiece | null {
	if (typeof raw !== 'object' || raw === null) return null;

	const video = raw as Record<string, unknown>;
	const url = typeof video.url === 'string' ? video.url : null;
	const id = (video.id as { value?: unknown } | undefined)?.value;
	const seconds = secondsOf(video);

	// A post with no url is not a row anybody can click, and one with no date cannot be ordered
	// against the other sources the page merges — so both are required rather than defaulted.
	if (url === null || seconds === null) return null;

	const author = (video.author as { name?: unknown } | undefined)?.name;

	return buildPost(source, {
		// The plugin's own id where it has one, falling back to the url — which is unique per video
		// and stable, and is what the id is for.
		id: typeof id === 'string' && id !== '' ? id : url,
		kind: 'video',
		url,
		title: typeof video.name === 'string' ? video.name : null,
		image: thumbnailOf(video),
		publishedAt: new Date(seconds * 1000).toISOString(),
		author: typeof author === 'string' && author !== '' ? author : handle,
		authorProfileUrl: `https://kick.com/${encodeURIComponent(handle)}`,
		views: typeof video.viewCount === 'number' ? video.viewCount : null,
		duration: typeof video.duration === 'number' ? video.duration : null,
		live: video.isLive === true
	});
}

export const kickSourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(ADVICE);

		const plugin = await loadPlugin(MANIFEST, { fetch: adapt(context) }).catch((cause: unknown) => {
			// The plugin, not Kick. Worth distinguishing, because an admin reading "Kick is down" would
			// go and check Kick — and this is the one failure here that is neither theirs nor Kick's.
			throw new SourceFailure(
				`Could not load the Kick reader (${cause instanceof Error ? cause.name : 'unknown error'}).`
			);
		});

		try {
			const feed = await plugin.feed(`https://kick.com/${encodeURIComponent(handle)}`);

			return feed.results
				.map((entry) => toPost(source, handle, entry))
				.filter((post): post is ContentPiece => post !== null);
		} catch (cause) {
			// The plugin's message is its own and may quote a url, so it is not passed through. The
			// orchestrator would replace a non-`SourceFailure` anyway; this says which platform it was.
			throw new SourceFailure(
				`Could not read Kick channel ${handle}. Kick may have changed, or the channel may not exist.`,
				{ cause }
			);
		} finally {
			// Not optional: the sandbox holds a WASM heap until it is disposed.
			plugin.dispose();
		}
	}
};
