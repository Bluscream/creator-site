/**
 * What a chat message is to this application.
 *
 * A chat message is an {@link Utterance} — nothing more. The type lives in `src/lib/canonical.ts`
 * alongside `ContentPiece`, because *something somebody said* is a shape a comment thread and a
 * chat log share, and a row renderer written for one draws the other. This module is what the *chat
 * capability* adds on top: how a page of it is reported, and what "unavailable" means.
 *
 * As with `live.ts`, these types are **this project's own** and nothing is re-exported from an SDK.
 * The client consumes exactly this shape over `/api/chat`, so a deployment reading chat through
 * Twitch EventSub or a YouTube live-chat poll instead of Synchra produces the same rows.
 *
 * ### What the canonical move changed
 *
 * The old `ChatMessage` carried `viewer`, `colour`, `avatar`, `profile` and `badges` as five sibling
 * fields, which is the same person described five times. They are now one `Actor`, which is also how
 * a post names its author — so one avatar component serves a chat row, a post row and a future
 * comment thread rather than one each. `provider` became `platform` and `created_at` became `at`,
 * which is what every other capability already called them. And `notice` was a boolean beside a
 * `kind` string, where only one of the four combinations was meaningful; it is now a single nullable
 * string, so "is this an event" and "which event" cannot disagree.
 *
 * ### Why the segment list is structural rather than imported
 *
 * `synchra-ts` resolves a message's typed parts into drawable segments — an emote arrives already
 * carrying its CDN url, a gift its image, a mention the resolved display name — and reimplementing
 * that would be exactly the wheel-reinvention this project avoids. So the *resolver* is the
 * library's. But the *contract* is declared in `canonical.ts`, with the same field names, which
 * means the library's result is structurally assignable and needs no mapping, while a second
 * provider is free to build the same segments any way it likes. If the library ever renames a field,
 * that declaration is where it becomes a compile error instead of a silently changed public API.
 */

export type { Actor, Badge, Segment, SegmentKind, Utterance } from './canonical.js';
export { SEGMENT_KINDS } from './canonical.js';

import type { Utterance } from './canonical.js';

/**
 * A page of chat, oldest first.
 *
 * `available: false` is not an error. Reading chat can be refused for this channel specifically —
 * a per-channel grant rather than a missing scope — and the rest of the page works regardless, so
 * it is reported rather than thrown.
 */
export interface Chat {
	readonly available: boolean;
	/** Why chat is unavailable, for the admin. Null when it is available. */
	readonly reason: string | null;
	readonly messages: readonly Utterance[];
}

/** Chat plus the cache's account of itself, which is what the endpoint returns. */
export interface ChatResult extends Chat {
	readonly age: number;
	readonly stale: boolean;
}

/** The empty result, for when nothing has ever been fetched successfully. */
export const NO_CHAT: Chat = {
	available: false,
	reason: null,
	messages: []
};
