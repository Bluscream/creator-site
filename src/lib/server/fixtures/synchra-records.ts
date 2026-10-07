/**
 * Upstream Synchra records, for the mapper tests.
 *
 * ### Why these are written out rather than recorded
 *
 * The live feed carries real viewers' display names, profile pictures and the things they typed in
 * somebody's chat. This repository is public. Recording a page of a real channel's chat into it
 * would publish all of that, so these are composed instead — same shapes, invented people.
 *
 * ### Why they are typed against the SDK rather than stored as JSON
 *
 * A JSON fixture drifts: the API adds a required field, the SDK's type gains it, and a hand-written
 * JSON blob keeps passing because nothing checks it against anything. Declaring these as
 * `ChatMessage` and `Activity` from `synchra-ts` means the compiler checks every fixture against
 * the real upstream contract on every build, and a field that changes shape upstream becomes an
 * error here rather than a surprise in production.
 *
 * Between them the records cover what the mapping actually has to get right: an ordinary message, a
 * notice whose content is in the *other* parts field, emotes and badges that resolve to images, an
 * absent colour and an absent avatar, money that needs scaling out of minor units, and a provider
 * that reports a CSS gradient where a colour was expected.
 */

import { TAccessLevel } from 'synchra-ts';
import type { Activity, ChatMessage } from 'synchra-ts';

/** The fields every chat message carries and the mapping never reads, so each record can omit them. */
const CHAT_BASE = {
	access_level: TAccessLevel.n0,
	channel_id: '01a00000-0000-7000-8000-000000000000',
	channel_provider_chat_id: null,
	channel_provider_stream_id: null,
	deleted_at: null,
	deleted_by_display_name: null,
	deleted_by_name: null,
	deleted_by_provider_viewer_id: null,
	notice_message_parts: [],
	outgoing_group_id: null,
	parent: null,
	parent_provider_thread_id: null,
	provider_logo_variant: null,
	source_provider_channel_display_name: null,
	source_provider_channel_id: null,
	source_provider_channel_name: null,
	updated_at: null,
	viewer_created_at: null,
	badges: []
} as const satisfies Partial<ChatMessage>;

/** An ordinary message: plain text, a chat colour, a picture, a public profile. */
export const PLAIN_MESSAGE: ChatMessage = {
	...CHAT_BASE,
	id: '01a00000-0000-7000-8000-000000000101',
	provider: 'twitch',
	provider_channel_id: '12345678',
	provider_message_id: 'twitch-msg-1',
	provider_viewer_id: '87654321',
	type: 'message',
	sub_type: null,
	message_parts: [{ type: 'text', text: 'first' }],
	viewer_color: '#1f8fff',
	viewer_display_name: 'Ada',
	viewer_name: 'ada',
	viewer_profile_picture_url: 'https://example.invalid/ada.png',
	created_at: '2026-10-06T13:17:09.482000Z'
};

/**
 * A message with an emote and badges.
 *
 * The emote's url comes from the record, not from a second request — Synchra resolves it upstream —
 * so the mapper's job is to pass it through at the size the library picks.
 */
export const EMOTE_MESSAGE: ChatMessage = {
	...CHAT_BASE,
	id: '01a00000-0000-7000-8000-000000000102',
	provider: 'twitch',
	provider_channel_id: '12345678',
	provider_message_id: 'twitch-msg-2',
	provider_viewer_id: '11112222',
	type: 'message',
	sub_type: null,
	message_parts: [
		{ type: 'text', text: 'nice ' },
		{
			type: 'emote',
			text: 'PogChamp',
			emote: {
				animated: false,
				emote_provider: 'twitch',
				id: 'emote-1',
				name: 'PogChamp',
				urls: {
					sm: 'https://example.invalid/emote-sm.png',
					md: 'https://example.invalid/emote-md.png',
					lg: 'https://example.invalid/emote-lg.png'
				}
			}
		}
	],
	badges: [
		{
			id: 'badge-1',
			name: 'Subscriber',
			type: 'subscriber',
			urls: {
				sm: 'https://example.invalid/badge-sm.png',
				md: 'https://example.invalid/badge-md.png',
				lg: 'https://example.invalid/badge-lg.png'
			}
		}
	],
	viewer_color: null,
	viewer_display_name: 'Grace',
	viewer_name: 'grace',
	viewer_profile_picture_url: null,
	created_at: '2026-10-06T13:18:00.000000Z'
};

/**
 * A TikTok gift.
 *
 * The record that breaks a naive reader: `message_parts` is empty and the content is in
 * `notice_message_parts`. `synchra-ts` measured 35 of 200 messages on a live channel arriving this
 * way, so a mapper that reads only `message_parts` draws a sixth of the chat as blank rows.
 */
export const NOTICE_MESSAGE: ChatMessage = {
	...CHAT_BASE,
	id: '01a00000-0000-7000-8000-000000000103',
	provider: 'tiktok',
	provider_channel_id: 'tiktok-channel',
	provider_message_id: 'tiktok-msg-1',
	provider_viewer_id: 'tiktok-viewer',
	type: 'notice',
	sub_type: 'tiktok_gift',
	message_parts: [],
	notice_message_parts: [
		{ type: 'text', text: 'sent ' },
		{
			type: 'gift',
			text: 'Rose',
			gift: {
				count: 1,
				id: 'gift-1',
				name: 'Rose',
				type: 'tiktok',
				animated: true,
				image_url: 'https://example.invalid/rose.png'
			}
		}
	],
	viewer_color: '#74b816',
	viewer_display_name: 'Linus',
	viewer_name: 'linus',
	viewer_profile_picture_url: 'https://example.invalid/linus.webp',
	created_at: '2026-10-06T13:19:32.000000Z'
};

/** Fields the mapping never reads, shared by the activity records. */
const ACTIVITY_BASE = {
	channel_id: '01a00000-0000-7000-8000-000000000000',
	contribution_group: null,
	font_color: null,
	gifted_viewers: null,
	provider_channel_id: 'channel',
	provider_message_id: 'activity-msg',
	provider_viewer_id: 'viewer',
	read: false
} as const satisfies Partial<Activity>;

/**
 * A money donation.
 *
 * `count: 500` with `count_decimal_place: 2` is 5.00 — the scaling the mapper has to do, and the
 * one piece of arithmetic in either mapper.
 */
export const DONATION: Activity = {
	...ACTIVITY_BASE,
	id: '01a00000-0000-7000-8000-000000000201',
	provider: 'twitch',
	type: 'charity_donation',
	type_display_name: 'Donation',
	sub_type: 'donation',
	sub_type_display_name: 'Donation',
	activity_group: 'donation',
	count: 500,
	count_decimal_place: 2,
	count_currency: 'EUR',
	count_name: 'euro',
	message_parts: [{ type: 'text', text: 'keep it up' }],
	system_message: 'Ada donated €5.00',
	color: '#1f8fff',
	viewer_display_name: 'Ada',
	viewer_name: 'ada',
	viewer_profile_picture_url: 'https://example.invalid/ada.png',
	created_at: '2026-10-06T13:19:32.000000Z'
};

/**
 * A TikTok gift as it arrives on the activity feed.
 *
 * Whole units, so no scaling; no attached message, so the plain text is empty; no classification,
 * so `activity_group` is null; and a CSS gradient where a client might expect a hex colour. The
 * gradient is why {@link ActivityEntry.colour} is documented as an arbitrary CSS value.
 */
export const GIFT: Activity = {
	...ACTIVITY_BASE,
	id: '01a00000-0000-7000-8000-000000000202',
	provider: 'tiktok',
	type: 'tiktok_gift',
	type_display_name: 'Diamonds',
	sub_type: 'gift',
	sub_type_display_name: 'Gift',
	activity_group: null,
	count: 1,
	count_decimal_place: 0,
	count_currency: null,
	count_name: 'diamond',
	message_parts: null,
	system_message: 'Linus sent Heart Me',
	color: 'linear-gradient(90deg, rgba(214, 173, 255, 1) 0%, rgba(214, 173, 255, 1) 100%)',
	viewer_display_name: 'Linus',
	viewer_name: 'linus',
	created_at: '2026-10-06T13:20:00.000000Z'
};
