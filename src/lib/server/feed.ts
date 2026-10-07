/**
 * The feed's configuration document.
 *
 * One module-level document rather than one per caller, so the parsed-and-validated result is
 * shared and the file is read once per change rather than once per request. See `document.ts` for
 * what makes that safe: the cache is keyed on the file's identity, so an edit is picked up on the
 * next request.
 */

import { document } from './document.js';
import { feedSchema } from './feed-config.js';
import type { FeedConfig } from './feed-config.js';
import { resolveSource } from './providers/post.js';
import type { ResolvedSource } from './providers/post.js';

/** `<data>/config/feed.json`. */
const feedDocument = document('feed', feedSchema);

/** The feed's settings, with every field present. */
export function feedConfig(): FeedConfig {
	return feedDocument.read();
}

/** Where the document is, for the admin to name and for a message. */
export function feedConfigPath(): string {
	return feedDocument.path;
}

/** Drops the cached parse. For tests, and for the admin right after it writes. */
export function forgetFeedConfig(): void {
	feedDocument.forget();
}

/**
 * The sources worth fetching, in configuration order.
 *
 * Hidden sources are filtered out here rather than at validation, which is the difference between
 * this and the PHP it replaces. A hidden source is still a configured one: the admin has to list
 * it to let somebody un-hide it, and dropping it during parsing would make it invisible to the
 * editor as well as to the fetcher. So the document keeps it and this is what skips it.
 */
export function feedSources(config: FeedConfig = feedConfig()): readonly ResolvedSource[] {
	return config.sources.filter((entry) => !entry.hidden).map(resolveSource);
}
