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
 * ### The cover images expire
 *
 * Every `coverUrl` is signed, with an `x-expires` about two days out. Nothing here can change that,
 * and it is a reason not to cache these posts for longer than that: a stale entry would render with
 * every picture broken, which looks worse than a feed that is briefly behind.
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
	if (seconds < 1_400_000_000 || seconds > 4_000_000_000) return null;

	return new Date(seconds * 1000).toISOString();
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

		if (!response.ok) {
			throw new SourceFailure(`TikTok answered ${String(response.status)} for @${handle}.`);
		}

		const page = pageOf(stateIn(await body(response)));

		// Reached both for an account that does not exist and for a page TikTok has changed the shape
		// of. Worth saying which two things it could be, because one is fixable by the admin and the
		// other is not.
		if (page === null) {
			throw new SourceFailure(
				`Could not read @${handle}'s videos. The account may not exist, or TikTok may have changed the page.`
			);
		}

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

	return buildPost(source, {
		id,
		kind: 'video',
		url: `https://www.tiktok.com/@${encodeURIComponent(owner)}/video/${encodeURIComponent(id)}`,
		title: headline(desc),
		excerpt: desc,

		// `playAddr` is deliberately unused: it is a signed link straight to the video file, which is
		// not what a feed row links to and would not survive being cached anyway.
		image: video.coverUrl ?? video.originCoverUrl,
		publishedAt: posted,
		author
	});
}
