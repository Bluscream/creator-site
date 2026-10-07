/**
 * The ways a post source can be read.
 *
 * Its own module, small on purpose: the configuration schema needs the list to validate a source's
 * `kind`, and the provider registry needs it to map a kind to the provider that reads it. Putting
 * it in either one would make the other import it and create a cycle between configuration and the
 * providers that configuration describes.
 *
 * ### Why there is a kind at all
 *
 * A source used to be nothing but a url, which was fine while every source was an RSS feed. It is
 * not fine now that some are APIs: Twitch wants a channel login and a pair of credentials, Bluesky
 * wants a handle, YouTube accepts any of several things that identify a channel. So a source names
 * the provider that reads it, and its `url` field means whatever that provider says it means.
 *
 * ### Why these, and not a public API per platform
 *
 * There is no single API returning "this creator's posts everywhere", and the services that come
 * closest are paid, per-seat, and want OAuth against each platform. For a page showing a dozen
 * public posts that is a monthly bill and a credential store for something the platforms already
 * publish openly. So each platform is read the best way it actually offers:
 *
 * | Kind      | How                                                | Needs           |
 * | :-------- | :------------------------------------------------- | :-------------- |
 * | `feed`    | the site's own RSS or Atom                          | nothing         |
 * | `youtube` | the channel feed YouTube still publishes, as Atom   | nothing         |
 * | `twitch`  | the official Helix API — videos and clips           | two credentials |
 * | `bluesky` | the public AppView, unauthenticated                 | nothing         |
 * | `tiktok`  | the page TikTok renders for embedding, which is server-rendered with the post list | nothing |
 *
 * `tiktok` is the surprising one, and it is the cheapest of the lot: one unauthenticated GET, no
 * key, no cookie, no signing. The endpoints you would reach for first are all worse — the official
 * Display API wants an app review and an OAuth consent screen to read posts that are already
 * public, and the endpoint the real profile page calls needs a signature produced by TikTok's own
 * obfuscated JavaScript, which is why the scrapers that attempt it drive a headless browser and
 * break so often.
 *
 * **Instagram, X and Threads are deliberately absent**, and that is the state of those platforms
 * rather than an omission here. Instagram needs a Business account and app review; X removed free
 * API reads. For those, the route that does not involve a credit card is a feed-manufacturing
 * bridge such as RSS-Bridge, run separately — and because a bridge speaks RSS, it arrives as an
 * ordinary `feed` source needing no kind of its own.
 *
 * Keeping the bridge out of this project is the point: its adapters break whenever a platform
 * changes its markup, and at arm's length a broken bridge costs one empty tab rather than a
 * release here.
 */

/**
 * Every kind a source may declare.
 *
 * A tuple rather than an array so zod can build an enum from it and a kind that is not one of these
 * is a validation failure rather than a lookup that returns nothing at runtime.
 */
export const POST_SOURCE_KINDS = ['feed', 'youtube', 'twitch', 'bluesky', 'tiktok'] as const;

/** One of {@link POST_SOURCE_KINDS}. */
export type PostSourceKind = (typeof POST_SOURCE_KINDS)[number];

/**
 * What a source with no `kind` is.
 *
 * An ordinary feed, because that is what most sources are — a blog, a Mastodon account, a PeerTube
 * channel, anything behind a bridge — and requiring the common case to be spelled out is noise in
 * every configuration file.
 */
export const DEFAULT_POST_SOURCE_KIND: PostSourceKind = 'feed';

/** Whether `value` names a kind. */
export function isPostSourceKind(value: string): value is PostSourceKind {
	return (POST_SOURCE_KINDS as readonly string[]).includes(value);
}
