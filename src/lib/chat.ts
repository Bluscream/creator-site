/**
 * What a chat message is to this application.
 *
 * As with `live.ts`, these types are **this project's own** and nothing is re-exported from an SDK.
 * The client consumes exactly this shape over `/api/chat`, so a deployment reading chat through
 * Twitch EventSub or a YouTube live-chat poll instead of Synchra produces the same rows.
 *
 * ### Why the segment list is structural rather than imported
 *
 * `synchra-ts` resolves a message's typed parts into drawable segments — an emote arrives already
 * carrying its CDN url, a gift its image, a mention the resolved display name — and reimplementing
 * that would be exactly the wheel-reinvention this project avoids. So the *resolver* is the
 * library's. But the *contract* is declared here, with the same field names, which means the
 * library's result is structurally assignable and needs no mapping, while a second provider is free
 * to build the same segments any way it likes. If the library ever renames a field, this file is
 * where that becomes a compile error instead of a silently changed public API.
 */

/** What a segment draws as. */
export const SEGMENT_KINDS = ['text', 'emote', 'gift', 'mention', 'link'] as const;

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * One drawable piece of a message.
 *
 * `text` is always meaningful — it is the plain-text fallback for this piece, which is what a title
 * attribute, a screen reader and a notification body get. `imageUrl` is the emote or gift picture
 * when there is one, so a client shows the emote instead of the word `KPOPvictory`.
 */
export interface MessageSegment {
	readonly kind: SegmentKind;
	readonly text: string;
	readonly imageUrl?: string | undefined;
	/** Whether the image is animated, so a client can respect `prefers-reduced-motion`. */
	readonly animated?: boolean | undefined;
	/** Where a link segment points. */
	readonly href?: string | undefined;
}

/** A sub, mod or VIP icon beside a viewer's name. */
export interface ViewerBadge {
	readonly name: string;
	readonly type: string;
	readonly imageUrl?: string | undefined;
}

/** One row of the chat log. */
export interface ChatMessage {
	readonly id: string;
	/** Which platform it was said on, lower case: `twitch`, `tiktok`, `youtube`, … */
	readonly provider: string;
	/** The viewer's display name, as the platform capitalises it. */
	readonly viewer: string;
	/** The viewer's chat colour, or null when the platform does not assign one. */
	readonly colour: string | null;
	readonly avatar: string | null;
	/** Where clicking the name goes, or null for a platform with no public profile page. */
	readonly profile: string | null;
	/** Plain text, for the title attribute and for accessibility. */
	readonly text: string;
	/** The same content resolved into drawable pieces. */
	readonly parts: readonly MessageSegment[];
	readonly badges: readonly ViewerBadge[];
	/**
	 * Whether this row is an event rather than something somebody typed.
	 *
	 * A gift, a sub or a raid arrives through the chat feed as a *notice*, and a client styles it
	 * apart. Worth stating because the content of a notice lives in a different field upstream, and
	 * a reader that does not know that renders every gift as a blank row.
	 */
	readonly notice: boolean;
	/** Which kind of notice, e.g. `tiktok_gift`, for the label. Null for an ordinary message. */
	readonly kind: string | null;
	/** ISO 8601 at second precision with an explicit zero offset. */
	readonly created_at: string;
}

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
	readonly messages: readonly ChatMessage[];
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
