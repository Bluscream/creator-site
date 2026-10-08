/**
 * TikTok posts, through the page TikTok renders for embedding.
 *
 * There is no public API for "this account's videos". The documented one is the oEmbed endpoint,
 * which describes a single video you already have the url of, and the Display API needs an approved
 * application plus the *account holder* going through OAuth — which a visitor's page cannot do and
 * an installer should not have to.
 *
 * What does work is `tiktok.com/embed/@handle`: a server-rendered page whose state is already in the
 * HTML, as JSON, in a `__FRONTITY_CONNECT_STATE__` script tag. One unauthenticated GET, no key, no
 * token. It is read rather than asked for, so it is the most fragile reader here by some distance —
 * which is why every field is optional and a shape it does not recognise fails the source rather
 * than the whole feed.
 *
 * ### Everything else that was tried, and what it answered
 *
 * Worth recording, because each of these reads like the obvious answer and four of them have a
 * README saying they work:
 *
 * | route | answer |
 * | --- | --- |
 * | `api/post/item_list` — what the profile page's own client calls | **200 with an empty body.** It wants `X-Bogus`/`msToken`, which are computed by TikTok's own obfuscated browser script from a device fingerprint. An empty 200 is the rejection |
 * | `tiktok.com/@handle` — the profile page | 200, and its `__UNIVERSAL_DATA_FOR_REHYDRATION__` carries the *user* and no video list. The posts are no longer server-rendered, which is why the client signs a request for them |
 * | oEmbed on a profile url | 200, and describes the profile — no video list. Useful, but only for the question {@link diagnose} asks it |
 * | `embed/v2/@handle`, `node/share/user/@handle` | 400 and 403 |
 * | GrayJay's official TikTok plugin | still tagged `wip`, still builds a `CustomWindow`/`CustomDocument` browser emulation to run TikTok's own page scripts, and its manifest now declares `authentication` with a `sessionid` cookie — so it wants a signed-in TikTok account, which a public site must not carry |
 * | GrayJay's unofficial TikTok plugin | still configured only for `localhost:3002` and the author's own LAN address |
 * | the maintained npm scraper | fails with "Empty response" after ten retries, because it calls `item_list`. It also pulls a native addon and an unmaintained crypto library |
 * | RSSHub's public instance | 403, self-host only — the same shape of dependency as the dead bridge host this project replaced |
 *
 * So the embed page is not a shortcut past a better option; it is the only unauthenticated route
 * that answers the question at all. It needs no browser user agent — a plain `node` one is served
 * the same page — which is the one piece of good news in that table.
 *
 * ### It returns eleven videos, and there is no second page
 *
 * Measured against an account with fifty-three. The embed's "load more" is the signed `item_list`
 * call above, so a page cursor is not something this can be given. Eleven is more than a feed row
 * shows and the orchestrator merges several sources anyway, so this is a ceiling rather than a bug —
 * but it is a real limit and not one to discover from a short feed.
 *
 * ### Three things measured against the live page, each of which would be a bug if assumed
 *
 * 1. **A video id is bigger than a JavaScript number, and the obvious shift is worse than that.**
 *    The ids are 19-digit snowflakes, so `Number('7691691649507839265')` loses the low bits — which
 *    on its own would not move the date, because the timestamp is in the *high* 32 bits. The real
 *    trap is `id >> 32`: `>>` coerces to Int32 and masks the shift count to five bits, so `>> 32` is
 *    `>> 0` and the one-liner returns a wrapped remnant of the id. {@link postedAt} uses `BigInt`,
 *    where the shift means what it says.
 * 2. **There is no date field at all.** Not `createTime`, not anything. The only timestamp is the
 *    one encoded in the id's top 32 bits, so deriving it is the only option rather than a shortcut.
 * 3. **Pinned videos come first, and nothing marks them.** The live page returned three videos from
 *    2025 ahead of nine from 2026, with no `isPinnedItem` to tell them apart. Sorting by the derived
 *    date is what fixes it — a creator's feed ordered by what they happened to pin would look
 *    broken — which is the second job the id's timestamp does.
 *
 * ### The cover images expire, and they say when
 *
 * Every `coverUrl` is signed, with an `x-expires` about two days out — and that is the url's own
 * query parameter, so the expiry is a fact to read rather than a lifetime to assume. {@link expiryOf}
 * takes it, which is what `Media.expiresAt` exists for: a stale post then keeps its title, its link
 * and its date and loses only the picture that has actually stopped working. {@link imageTtl} stays
 * as the coarse fallback for a cover url that carries no expiry at all.
 *
 * The *avatar* is signed the same way and is deliberately not taken. `Actor` has nowhere to put an
 * expiry, so a cached post would hold an avatar url that 404s with nothing able to notice — the
 * profile url is taken instead, which is unsigned and permanent.
 */

import { z } from 'zod';
import type { ContentPiece } from '../../posts.js';
import { buildPost, headline } from './post.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

/** A handle: 2–24 of these characters, which is what TikTok allows. */
const HANDLE = /^@?[\w.]{2,24}$/;

/** The same, inside a url path. */
const PATH_HANDLE = /\/@([\w.]{2,24})/;

const ADVICE = 'Use the account’s @handle, or a link to its profile.';

/**
 * The state blob, as HTML.
 *
 * Non-greedy to the first `</script>`, which is safe because the content is JSON and JSON cannot
 * contain that sequence unescaped.
 */
const STATE = /id="__FRONTITY_CONNECT_STATE__"[^>]*>(.*?)<\/script>/s;

/**
 * How much of the page is read before giving up.
 *
 * The real page is about 300 kB. This is a bound on a broken or hostile response streaming without
 * end, which would otherwise be read into memory until the process died.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/** A snowflake id: the only thing this will do arithmetic on. */
const SNOWFLAKE = /^\d{1,20}$/;

/**
 * The window a unix-seconds value has to land in to be believed.
 *
 * Shared by the id's derived timestamp and the cover url's `x-expires`, because the question is the
 * same both times — is this a second count somebody meant, or a number that merely parsed. The floor
 * is before TikTok existed and the ceiling is far enough out that no real signature reaches it.
 */
const EPOCH_FLOOR = 1_400_000_000;
const EPOCH_CEILING = 4_000_000_000;

/** The documented endpoint, asked one question only. See {@link diagnose}. */
const OEMBED = 'https://www.tiktok.com/oembed';

/**
 * As much of the embed state as this reads.
 *
 * Every field optional, because this is scraped rather than promised: a page that drops one should
 * cost the field, or at worst the entry, rather than the source. `loose` for the same reason.
 */
const videoSchema = z
	.object({
		id: z.string().optional(),
		desc: z.string().optional(),
		coverUrl: z.string().optional(),
		originCoverUrl: z.string().optional(),
		authorUniqueId: z.string().optional(),

		// The cover's pixel dimensions, which the page states per video rather than per account —
		// these feeds mix portrait and the occasional landscape, so one assumed ratio reflows.
		width: z.number().optional(),
		height: z.number().optional(),

		// The only engagement number the page carries. Taken because `ContentPiece.views` exists and
		// this was being dropped on the floor.
		playCount: z.number().optional(),

		// A video the account holder has made private is still listed, and its page is not readable.
		privateItem: z.boolean().optional()
	})
	.loose();

/** One video of the embedded list. */
type Video = z.output<typeof videoSchema>;

const pageSchema = z
	.object({
		videoList: z.array(videoSchema).optional(),
		userInfo: z
			// `avatarThumbUrl` sits beside these and is deliberately not read: it is signed and expires,
			// and `Actor` has nowhere to record that. See the module comment.
			.object({ uniqueId: z.string().optional(), nickname: z.string().optional() })
			.loose()
			.optional()
	})
	.loose();

/** One page of the Frontity state. */
type EmbedPage = z.output<typeof pageSchema>;

const stateSchema = z
	.object({
		source: z
			.object({
				// Keyed by route — `/embed/@someone` — so the key is not known in advance and the entry
				// is found by looking for the one that holds a video list.
				data: z.record(z.string(), z.unknown()).optional()
			})
			.loose()
			.optional()
	})
	.loose();

/** The handle `target` names, lower-cased, or null. */
export function handleOf(target: string): string | null {
	const trimmed = target.trim();

	if (trimmed === '') return null;

	if (/^https?:\/\//i.test(trimmed)) {
		let path: string;

		try {
			path = new URL(trimmed).pathname;
		} catch {
			return null;
		}

		return PATH_HANDLE.exec(path)?.[1]?.toLowerCase() ?? null;
	}

	return HANDLE.test(trimmed) ? trimmed.replace(/^@/, '').toLowerCase() : null;
}

/**
 * When a video was posted, from the timestamp in its id.
 *
 * A TikTok id is a snowflake: unix seconds in the top 32 bits. `BigInt` rather than `Number`, not
 * for the precision — the lost low bits are below the timestamp — but for the shift. On a `Number`,
 * `>> 32` coerces to Int32 and masks the count to five bits, making it `>> 0`: no error, no warning,
 * just a wrapped remnant of the id presented as a date. See the module comment.
 */
export function postedAt(id: string): string | null {
	if (!SNOWFLAKE.test(id)) return null;

	const seconds = Number(BigInt(id) >> 32n);

	// A shifted id that lands before TikTok existed is not a timestamp, which is the signal that the
	// id is not a snowflake at all rather than that the video is old.
	if (!plausible(seconds)) return null;

	return new Date(seconds * 1000).toISOString();
}

/** Whether a number is a unix-seconds value somebody meant. See {@link EPOCH_FLOOR}. */
function plausible(seconds: number): boolean {
	return seconds >= EPOCH_FLOOR && seconds <= EPOCH_CEILING;
}

/**
 * When a signed cdn url stops working, in unix seconds, or undefined.
 *
 * TikTok puts the expiry in the url it signs, as `x-expires`, so this is the url stating its own
 * lifetime rather than this module guessing one. Read with `URL` rather than a regex because that is
 * what decodes the query string correctly, and undefined for anything that is not a plausible second
 * count — an unreadable expiry has to mean "no expiry known" and fall back to {@link imageTtl},
 * since treating it as already-expired would drop every picture on the page.
 */
export function expiryOf(url: string): number | undefined {
	let raw: string | null;

	try {
		raw = new URL(url).searchParams.get('x-expires');
	} catch {
		return undefined;
	}

	if (raw === null || !/^\d{1,12}$/.test(raw)) return undefined;

	const seconds = Number(raw);

	return plausible(seconds) ? seconds : undefined;
}

/** The one state entry that holds a video list. */
export function pageOf(state: unknown): EmbedPage | null {
	const parsed = stateSchema.safeParse(state);

	if (!parsed.success) return null;

	for (const value of Object.values(parsed.data.source?.data ?? {})) {
		const page = pageSchema.safeParse(value);

		if (page.success && page.data.videoList !== undefined) return page.data;
	}

	return null;
}

/** The embed state parsed out of the page's HTML, or null. */
export function stateIn(html: string): unknown {
	const found = STATE.exec(html)?.[1];

	if (found === undefined) return null;

	try {
		return JSON.parse(found);
	} catch {
		return null;
	}
}

export const tiktokSourceProvider: PostsSourceProvider = {
	// Measured: a cover url's `x-expires` was about 44 hours out. 36 is that with room for a
	// shorter one, which costs only the pictures on a feed that has been failing for a day and a
	// half — by which point they are about to 404 anyway.
	imageTtl: 36 * 60 * 60,

	unusable(source: ResolvedSource): string | null {
		return handleOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const handle = handleOf(source.target);

		if (handle === null) throw new SourceFailure(ADVICE);

		const response = await context.fetch(
			`https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`
		);

		// A missing account answers 400 here rather than 404, with a state blob that parses and holds
		// no video list — so a bad status and an unreadable page are the same situation and are asked
		// about together rather than reported as two different problems.
		const page = response.ok ? pageOf(stateIn(await body(response))) : null;

		if (page === null) throw new SourceFailure(await diagnose(handle, response.status, context));

		const author = page.userInfo?.nickname ?? page.userInfo?.uniqueId ?? handle;

		return (
			(page.videoList ?? [])
				.filter((video) => video.privateItem !== true)
				.map((video) => toPost(video, source, handle, author))
				.filter((post): post is ContentPiece => post !== null)
				// Sorted here rather than left to the orchestrator, because the orchestrator sorts the
				// merged list and a pinned video would still be wrong relative to this account's own.
				// `??` only to satisfy the type: `toPost` drops a video it could not date.
				.toSorted((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
		);
	}
};

/** The response body, refusing one that is implausibly large. */
async function body(response: Response): Promise<string> {
	const declared = Number(response.headers.get('content-length') ?? '0');

	if (declared > MAX_BYTES) throw new SourceFailure('The TikTok page is too large to read.');

	const text = await response.text();

	// Checked again after reading, because `content-length` is absent on a chunked response — which
	// is exactly how an endless stream would arrive.
	if (text.length > MAX_BYTES) throw new SourceFailure('The TikTok page is too large to read.');

	return text;
}

/** One listed video as a post, or null when it is not one. */
function toPost(
	video: Video,
	source: ResolvedSource,
	handle: string,
	author: string
): ContentPiece | null {
	const { id, desc } = video;

	if (id === undefined || !SNOWFLAKE.test(id)) return null;

	// The video's own `authorUniqueId` rather than the configured handle, so a renamed account's
	// links keep working off whatever the page itself says.
	const owner = video.authorUniqueId ?? handle;
	const posted = postedAt(id);

	// Dropped rather than dated null: the date is what this reader sorts on, and an undated video
	// would sink to the end of the feed where it would look like the oldest thing the account has.
	if (posted === null) return null;

	// `playAddr` is deliberately unused: it is a signed link straight to the video file, which is
	// not what a feed row links to and would not survive being cached anyway.
	const cover = video.coverUrl ?? video.originCoverUrl;
	const profile = `https://www.tiktok.com/@${encodeURIComponent(owner)}`;

	return buildPost(source, {
		// From the public profile payload, unauthenticated. TikTok has private and friends-only
		// videos, and none of them appear in what an anonymous request returns — which is the
		// reason this is sound and would not be if a session cookie were ever added.
		visibility: 'public',
		id,
		kind: 'video',
		url: `${profile}/video/${encodeURIComponent(id)}`,
		title: headline(desc),
		excerpt: desc,
		image: cover,

		// The url's own `x-expires`, not a lifetime assumed for the platform. Undefined where it has
		// none, which leaves the provider's coarse `imageTtl` to cover it.
		imageExpiresAt: cover === undefined ? undefined : expiryOf(cover),

		// The cover is a frame of the video, so the video's dimensions are the cover's.
		imageWidth: video.width,
		imageHeight: video.height,
		publishedAt: posted,
		author,

		// The unsigned, permanent half of the author's identity. The avatar beside it is signed and
		// expires, and nothing downstream could notice — see the module comment.
		authorProfileUrl: profile,
		views: video.playCount
	});
}

/**
 * Why the embed page could not be read, as a sentence for an admin.
 *
 * The hedge this replaces — "the account may not exist, or TikTok may have changed the page" — named
 * two causes without saying which, and one of them is the admin's to fix while the other is nobody's.
 * oEmbed answers it: it is TikTok's own documented endpoint, it needs no key, and it returns 400 for
 * a handle that does not exist and 200 with the profile's details for one that does.
 *
 * One extra request, only on the failure path, so the working case still costs a single GET. If
 * oEmbed cannot be reached either, the original hedge is the honest answer and is what comes back.
 */
async function diagnose(handle: string, status: number, context: SourceContext): Promise<string> {
	const url = `${OEMBED}?${new URLSearchParams({ url: `https://www.tiktok.com/@${handle}` }).toString()}`;

	let exists: boolean | null = null;

	try {
		const response = await context.fetch(url);

		// Only the status is read. The body would do as well, but it is somebody else's JSON on a path
		// that is already reporting a failure, and the status is the whole signal.
		if (response.status === 200) exists = true;
		else if (response.status === 400 || response.status === 404) exists = false;
	} catch {
		// Left null. A diagnosis that fails is not a failure worth replacing the real one with.
	}

	if (exists === false) return `TikTok has no account called @${handle}.`;

	if (exists === true) {
		return `TikTok answered ${String(status)} for @${handle}'s embed page and its videos could not be read, although the account exists. TikTok may have changed the page.`;
	}

	return `Could not read @${handle}'s videos (TikTok answered ${String(status)}). The account may not exist, or TikTok may have changed the page.`;
}
