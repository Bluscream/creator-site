/**
 * What "live" means to this application.
 *
 * These types are **this project's**, not a vendor's. Nothing here is re-exported from an SDK, and
 * no field exists because a particular API happened to return it. That is the whole point of the
 * provider layer: a deployment might answer these questions through Synchra, Restream, Twitch's own
 * API or a self-hosted Owncast, and the page must not be able to tell which.
 *
 * Shared rather than server-only because the client consumes exactly this shape over `/api/live`.
 */

/** One platform's state. */
export interface PlatformState {
	/** Whether the creator is broadcasting on this platform right now. */
	live: boolean;
	/** Concurrent viewers, or null when the platform does not say. */
	viewers: number | null;
	/** The stream title, or null when offline or unavailable. */
	title: string | null;
	/** Where a visitor goes to watch, or null when it cannot be worked out. */
	url: string | null;
	/** The creator's handle on this platform. */
	handle: string | null;
	/** When this broadcast started, ISO 8601 at second precision, or null. */
	started_at: string | null;
	/**
	 * The platform's own id for this broadcast.
	 *
	 * For YouTube that is the video id, which its live-chat embed needs — so a chat tab for YouTube
	 * can only be offered while a stream is actually running. Reported as the platform gives it; a
	 * caller checks the shape before building a URL out of it.
	 */
	stream_id: string | null;
}

/**
 * Live state across every platform the creator has connected.
 *
 * Every connected platform appears, including the ones that are offline: the page lists them all
 * and marks which are live, so an absent key and `live: false` are not interchangeable.
 */
export interface LiveStatus {
	any_live: boolean;
	/** Viewers summed across live platforms, or null when none of them reported a count. */
	total_viewers: number | null;
	platforms: Record<string, PlatformState>;
}

/** Live state plus the cache's account of itself, which is what the endpoint returns. */
export interface LiveStatusResult extends LiveStatus {
	/** Seconds since this was fetched. 0 when it was just now. */
	age: number;
	/** True when a refresh did not happen and a previous value is being served. */
	stale: boolean;
	/** Why the refresh did not happen, or null. Can be set alongside usable data. */
	error: string | null;
}

/** The empty result, for when nothing has ever been fetched successfully. */
export const NO_LIVE_STATUS: LiveStatus = {
	any_live: false,
	total_viewers: null,
	platforms: {}
};

/**
 * Where to watch a given platform, from its name and the creator's handle.
 *
 * Here rather than in a provider because it is a property of the *platform*, not of whoever told us
 * about it: Synchra, Restream and Twitch's own API all report a handle and none of them report a
 * watch URL. A platform this does not know gets null and the caller omits the link, which beats
 * guessing a URL shape and sending visitors to a 404.
 */
export function watchUrl(platform: string, handle: string | null): string | null {
	if (handle === null || handle === '') return null;

	switch (platform) {
		case 'twitch':
			return `https://www.twitch.tv/${handle}`;
		case 'youtube':
			return `https://www.youtube.com/@${handle}/live`;
		case 'tiktok':
			return `https://www.tiktok.com/@${handle}/live`;
		case 'kick':
			return `https://kick.com/${handle}`;
		case 'rumble':
			return `https://rumble.com/c/${handle}`;
		default:
			return null;
	}
}

/** A connected platform that is not currently broadcasting. */
export function offlinePlatform(platform: string, handle: string | null): PlatformState {
	return {
		live: false,
		viewers: null,
		title: null,
		url: watchUrl(platform, handle),
		handle,
		started_at: null,
		stream_id: null
	};
}

/**
 * An ISO 8601 timestamp at second precision with an explicit zero offset.
 *
 * `2026-10-07T04:07:08+00:00`, which is what the PHP endpoints emitted and what the recorded
 * responses contain — not `toISOString()`, which adds milliseconds and a `Z`. Providers return
 * timestamps in whatever shape their API uses, so normalising happens here, once.
 */
export function atom(value: string | Date | null | undefined): string | null {
	if (value === null || value === undefined || value === '') return null;

	const at = value instanceof Date ? value : new Date(value);

	return Number.isNaN(at.getTime()) ? null : `${at.toISOString().slice(0, 19)}+00:00`;
}
