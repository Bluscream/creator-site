/**
 * Synchra as a provider.
 *
 * Ported from `Feed::readLiveStatus()`. The logic is the same two reads merged; what is new is that
 * it sits behind {@link LiveProvider}, so a deployment without a Synchra account can answer the
 * same question through Restream, Twitch's own API or Owncast instead.
 *
 * ### Anonymous where anonymous works
 *
 * `synchra-ts` marks the nine operations that answer without a credential, because the published
 * API description cannot tell you which they are. Two of them are the ones this file needs, and its
 * own doc comment says that together they are enough to build a live-status page with no token at
 * all — verified against the live API.
 *
 * Using the token for them would work and would be wrong: live status would then break the moment
 * the token is narrowed or revoked, and live status is the thing that should survive that. This is
 * the same split the PHP drew between `hasChannel()` and `isConfigured()`.
 */

import {
	AuthenticationError,
	AuthorizationError,
	MessageContent,
	NotFoundError,
	Synchra,
	SynchraError,
	profileUrl
} from 'synchra-ts';
import type { Activity as SynchraActivity, ChatMessage as SynchraChatMessage } from 'synchra-ts';
import { NO_ACTIVITY } from '#lib/activity.js';
import type { Activity, ActivityEntry } from '#lib/activity.js';
import { NO_CHAT } from '#lib/chat.js';
import type { Chat, ChatMessage } from '#lib/chat.js';
import { atom, offlinePlatform, watchUrl } from '#lib/live.js';
import type { LiveStatus, PlatformState } from '#lib/live.js';
import { ServiceFailure, notConfigured } from '#lib/server/failure.js';
import type { Credential } from '#lib/server/providers/credentials.js';
import type {
	ActivityProvider,
	ChatProvider,
	LiveProvider,
	ProviderDescriptor,
	ProviderFactory
} from '#lib/server/providers/types.js';

const descriptor: ProviderDescriptor = {
	id: 'synchra',
	name: 'Synchra',
	capabilities: ['live', 'chat', 'activity'],
	setupUrl: 'https://dash.synchra.net'
};

/**
 * Turns a `synchra-ts` failure into a refusal with a reason.
 *
 * `synchra-ts` exports a real hierarchy — `AuthenticationError` and `AuthorizationError` extend
 * `ApiError`, which extends `SynchraError` — so these are `instanceof` checks rather than tests on
 * `error.name`. A renamed class is then a compile error here instead of a branch that quietly stops
 * matching.
 */
function asFailure(error: unknown): ServiceFailure {
	if (error instanceof ServiceFailure) return error;

	if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
		// A 403 on a channel the token was not granted on looks exactly like a missing scope and is
		// not one. Either way the operator has to fix the token, so both land here.
		return new ServiceFailure('token_rejected');
	}

	if (error instanceof SynchraError) {
		// A transport failure, a rate limit, a 5xx upstream, a response that would not deserialise:
		// all temporary from the visitor's point of view.
		return new ServiceFailure('upstream_unavailable');
	}

	return new ServiceFailure('internal_error', 500);
}

class SynchraLiveProvider implements LiveProvider {
	readonly descriptor = descriptor;

	readonly #client: Synchra;
	readonly #channelId: string;

	constructor(credential: Credential) {
		if (credential.channelId === undefined) throw notConfigured();

		// Anonymous deliberately — see the module comment. The token is for chat and activity.
		this.#client = Synchra.anonymous();
		this.#channelId = credential.channelId;
	}

	async liveStatus(): Promise<LiveStatus> {
		try {
			return await this.#read();
		} catch (error) {
			throw asFailure(error);
		}
	}

	/**
	 * Two reads, merged.
	 *
	 * The registered providers give every platform the creator has connected, with everything off;
	 * the live streams then turn on the ones that are broadcasting. The providers read cannot be
	 * skipped just because the streams read is faster — a connected-but-offline platform has to
	 * appear, because the page lists them all and marks which are live.
	 */
	async #read(): Promise<LiveStatus> {
		const connected = await this.#client.channelProvider.getChannelProviders({
			channel_id: this.#channelId
		});

		const platforms: Record<string, PlatformState> = {};

		for (const entry of connected) {
			platforms[entry.provider] = offlinePlatform(
				entry.provider,
				entry.provider_channel_name ?? null
			);
		}

		const page = await this.#client.channelProvider.getChannelProviderStreams({
			channel_id: this.#channelId,
			status: ['live'],
			per_page: 25
		});

		let anyLive = false;
		let totalViewers: number | null = null;

		for (const stream of page.records) {
			anyLive = true;

			// `viewer_count` is `number | null` — never undefined — so one check, not two.
			if (stream.viewer_count !== null) {
				totalViewers = (totalViewers ?? 0) + stream.viewer_count;
			}

			// A stream can exist for a platform the channel no longer lists, so keep whatever URL and
			// handle were already worked out and fall back to the stream's own channel id.
			const known = platforms[stream.provider];

			platforms[stream.provider] = {
				live: true,
				viewers: stream.viewer_count ?? null,
				title: stream.title ?? null,
				// `provider_channel_id` is non-nullable on a stream, so it needs no `?? null` guard.
				url: known?.url ?? watchUrl(stream.provider, stream.provider_channel_id),
				handle: known?.handle ?? stream.provider_channel_id,
				started_at: atom(stream.started_at),
				stream_id: stream.provider_stream_id ?? null
			};
		}

		return { any_live: anyLive, total_viewers: totalViewers, platforms };
	}
}

/**
 * The factory the registry holds.
 *
 * `usable` asks only for a channel id, because the live capability is the anonymous one. A token
 * configured without a channel is not enough, and a channel without a token is.
 */
export const synchraLive: ProviderFactory<LiveProvider> = {
	descriptor,
	usable: (credential) => credential.channelId !== undefined && credential.channelId !== '',
	create: (credential) => new SynchraLiveProvider(credential)
};

/**
 * A required timestamp, normalised, keeping the original if it will not parse.
 *
 * {@link atom} answers null for something it cannot read, and these fields are not optional in this
 * project's types. Passing the upstream string through beats inventing `new Date()`, which would
 * put a message in the wrong place in the log and look like a real timestamp while doing it.
 */
function requiredAtom(value: string): string {
	return atom(value) ?? value;
}

/**
 * Whether being refused this feed should be reported rather than thrown.
 *
 * 403 and 404 both mean "this token does not read this channel's feed" — per-channel access is
 * granted separately from scope, so a token with the right scope still gets a 403 for a channel it
 * was not granted on, and `synchra-ts` documents that as the usual cause. Either way it is a
 * configuration state, not a failure: the rest of the page is fine and the admin needs to be told.
 */
function isRefusal(error: unknown): boolean {
	return error instanceof AuthorizationError || error instanceof NotFoundError;
}

/**
 * Chat, from Synchra.
 *
 * Anonymous, like live status: `getChatMessages` is one of the nine operations `synchra-ts` marks
 * as answering without a credential, verified against the live API. The PHP sent the token here and
 * carried a 403 fallback for when it was not accepted — this needs neither, so a deployment with no
 * token at all still shows chat.
 */
class SynchraChatProvider implements ChatProvider {
	readonly descriptor = descriptor;

	readonly #client: Synchra;
	readonly #channelId: string;

	constructor(credential: Credential) {
		if (credential.channelId === undefined) throw notConfigured();

		this.#client = Synchra.anonymous();
		this.#channelId = credential.channelId;
	}

	async chat(limit: number): Promise<Chat> {
		try {
			const page = await this.#client.chat.getChatMessages({
				channel_id: this.#channelId,
				per_page: limit
			});

			return describeChatPage(page.records);
		} catch (error) {
			if (isRefusal(error)) {
				return { ...NO_CHAT, reason: 'This token cannot read the channel chat.' };
			}

			throw asFailure(error);
		}
	}
}

/**
 * A page of chat records, mapped and put in reading order.
 *
 * Its own function rather than two lines inside the provider so the ordering can be checked without
 * a Synchra account — and the ordering is worth checking, because getting it wrong produces a chat
 * log that is subtly backwards rather than one that is obviously broken.
 *
 * The API returns newest first, which is right for a cursor and wrong for a log: a reader starts at
 * the top.
 */
export function describeChatPage(records: readonly SynchraChatMessage[]): Chat {
	return { available: true, reason: null, messages: records.map(describeMessage).reverse() };
}

/**
 * One chat message, in this project's shape.
 *
 * Avatars are whatever the message itself carried. The PHP additionally resolved a missing picture
 * through its own avatar store, a few viewers per refresh — that store is driven by settings an
 * admin edits, so it belongs with the admin and the database rather than here, and is not ported
 * yet. TikTok, which is where most of the traffic comes from, already sends a picture.
 */
export function describeMessage(message: SynchraChatMessage): ChatMessage {
	// A notice — a gift, a sub, a raid — leaves `message_parts` empty and puts its content in
	// `notice_message_parts`, so reading only the former renders every one of them as a blank row.
	// `contentParts` is the library's answer to that, and it is why this does not index the fields
	// directly.
	const parts = MessageContent.contentParts(message);

	return {
		id: message.id,
		provider: message.provider,
		viewer: message.viewer_display_name,
		colour: message.viewer_color,
		avatar: message.viewer_profile_picture_url,
		// Synchra knows the handle, not the public page, so the library builds the url — undefined
		// for a platform with no public profile, which this project reports as null.
		profile: profileUrl(message) ?? null,
		text: MessageContent.plainText(parts),
		parts: MessageContent.segments(parts),
		badges: MessageContent.badges(message.badges),
		notice: MessageContent.isNotice(message),
		kind: message.sub_type,
		created_at: requiredAtom(message.created_at)
	};
}

/**
 * Which activity groups count as "someone just supported the channel".
 *
 * A follow, a raid, a redeem and a like also arrive on this feed and are not what the toasts are
 * for. Filtered upstream rather than here so the `per_page` limit counts the events that will
 * actually be shown.
 */
const SUPPORT_GROUPS = [
	'donation',
	'subscription',
	'subscription_gift',
	'virtual_currency'
] as const;

/**
 * Support activity, from Synchra.
 *
 * Unlike live status and chat, this one needs the token: `synchra-ts` records that an anonymous call
 * answers 401. So the factory asks for a token as well as a channel, and a deployment with only a
 * channel id reports activity as not configured while the rest of the page carries on.
 */
class SynchraActivityProvider implements ActivityProvider {
	readonly descriptor = descriptor;

	readonly #client: Synchra;
	readonly #channelId: string;

	constructor(credential: Credential) {
		if (credential.channelId === undefined || credential.token === undefined) throw notConfigured();

		this.#client = Synchra.withToken(credential.token);
		this.#channelId = credential.channelId;
	}

	async activity(limit: number): Promise<Activity> {
		try {
			const page = await this.#client.channelActivity.getActivities({
				channel_id: this.#channelId,
				activity_group: [...SUPPORT_GROUPS],
				per_page: limit
			});

			return { available: true, reason: null, activities: page.records.map(describeActivity) };
		} catch (error) {
			if (isRefusal(error)) {
				return { ...NO_ACTIVITY, reason: 'This token cannot read the channel activity feed.' };
			}

			throw asFailure(error);
		}
	}
}

/**
 * One support event, in this project's shape.
 *
 * Exported, like {@link describeMessage}, because the mapping *is* the response contract and a pure
 * function is the only part of this file that can be checked without a Synchra account. The two of
 * them are what the fixture tests drive.
 */
export function describeActivity(activity: SynchraActivity): ActivityEntry {
	return {
		id: activity.id,
		provider: activity.provider,
		type: activity.type,
		type_label: activity.type_display_name,
		group: activity.activity_group,
		viewer: activity.viewer_display_name,
		avatar: activity.viewer_profile_picture_url ?? null,
		// Money arrives as an integer plus a decimal place: 500 with two places is 5.00.
		amount:
			activity.count_decimal_place > 0
				? activity.count / 10 ** activity.count_decimal_place
				: activity.count,
		currency: activity.count_currency,
		count_name: activity.count_name,
		// Plain text for the headline and the notification body, plus the resolved segments so a
		// toast can draw the emotes a donation message contains instead of their names.
		message: MessageContent.plainText(activity.message_parts),
		message_parts: MessageContent.segments(activity.message_parts),
		system_message: activity.system_message,
		colour: activity.color,
		created_at: requiredAtom(activity.created_at)
	};
}

/** Chat needs only a channel, because reading it is anonymous. */
export const synchraChat: ProviderFactory<ChatProvider> = {
	descriptor,
	usable: (credential) => credential.channelId !== undefined && credential.channelId !== '',
	create: (credential) => new SynchraChatProvider(credential)
};

/** Activity needs a token as well — an anonymous call answers 401. */
export const synchraActivity: ProviderFactory<ActivityProvider> = {
	descriptor,
	usable: (credential) =>
		credential.channelId !== undefined &&
		credential.channelId !== '' &&
		credential.token !== undefined &&
		credential.token !== '',
	create: (credential) => new SynchraActivityProvider(credential)
};
