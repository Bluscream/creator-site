/**
 * One way of getting performance numbers out of a platform.
 *
 * The same shape as `posts-source.ts`, and deliberately over the **same configured sources**: a
 * creator who has said "this is my Twitch channel" for the feed should not have to say it again for
 * the metrics. So a metrics provider is keyed by source kind, takes a {@link ResolvedSource}, and
 * gets the same {@link SourceContext} — the shared `fetch` with its deadline and headers, and the
 * long-lived store for identifiers it had to resolve.
 *
 * ### Two kinds of source, both in scope
 *
 * - **The platform's own analytics**, read with the creator's linked credential. YouTube Analytics,
 *   Twitch, TikTok. These give the real numbers and only exist on a creator's own install.
 * - **A third party that collects or publishes numbers** about a platform. Often the only option,
 *   and always the only option on a fan's install, which holds no credentials at all.
 *
 * A provider says which it is with {@link MetricReading.origin}, because a page showing one number
 * has to be able to say where it came from — a platform's own figure and somebody else's estimate
 * are not interchangeable, and silently mixing them produces a number nobody should quote.
 *
 * ### The contract
 *
 * - Return readings, or an empty list. An account with nothing to report is not an error.
 * - **State the window.** A platform that reports views over 28 days must say so; a reading whose
 *   window is wrong is added to numbers it has nothing to do with.
 * - **State whether it is complete.** A figure covering only what this install happened to read is
 *   not the channel's total, and saying it is would be wrong by an unknowable margin.
 * - Throw {@link SourceFailure} with a message safe to show an admin, and **never put a credential
 *   in it**. The orchestrator catches it, records it against that platform, and the rest of the
 *   page still renders.
 */

import type { MetricReading } from '../../metrics.js';
import type { ResolvedSource } from './post.js';
import type { SourceContext } from './posts-source.js';

/** One way of reading a platform's numbers. */
export interface MetricsSourceProvider {
	/**
	 * Whether this provider can read the given source at all.
	 *
	 * Asked before any request, exactly as on the posts seam, so a source that can never work —
	 * no credential configured, a target that is not one — says so immediately rather than failing
	 * once per refresh forever. On a fan's install this is where "that needs the creator's own
	 * account" belongs.
	 *
	 * @returns the reason it cannot, or null when it can
	 */
	unusable(source: ResolvedSource): string | null;

	/** The numbers for this source. */
	read(source: ResolvedSource, context: SourceContext): Promise<readonly MetricReading[]>;
}
