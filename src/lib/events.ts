/**
 * What the server pushes to the browser, and under which topic.
 *
 * The site's live parts — the chat overlay, the support toasts, the live badge — are all
 * server→browser, so they arrive over one SSE stream rather than being polled. §6 has the reasoning
 * and the alternatives; this file is the contract.
 *
 * ### Topics are subscriptions, not routing hints
 *
 * A browser asks for the topics it can actually use: the chat overlay wants `chat` and nothing
 * else, the links page wants `live`, the stream's own OBS source wants `chat` and `activity`. A
 * client that received everything and filtered in JavaScript would hold a connection open for
 * traffic it throws away — and on a busy TikTok stream that is most of it.
 *
 * ### The payloads are the same domain types the endpoints return
 *
 * Deliberately. A client that can render a message from `GET /api/chat` can render one that arrived
 * over SSE, with no second mapping and no second set of field names to keep in step. The transport
 * is the only difference between them, which is what makes "fetch the backlog, then stream" work.
 */

import type { ActivityEntry } from '#lib/activity.js';
import type { Utterance } from '#lib/chat.js';
import type { PlatformState } from '#lib/live.js';

/** The streams a browser can subscribe to. */
export const TOPICS = ['chat', 'activity', 'live'] as const;

export type Topic = (typeof TOPICS)[number];

/**
 * What happened to the thing the event carries.
 *
 * Worth being explicit about, because the same topic delivers all three: a deleted chat message
 * arrives as a `chat` event with `action: 'deleted'`, not as its own topic. A client that ignores
 * this renders a moderator's deletion as a brand new message — which is the exact opposite of what
 * the moderator asked for, and is why this is not optional in the shape.
 */
export const EVENT_ACTIONS = ['new', 'updated', 'deleted'] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

/** A chat message appeared, changed or was removed. */
export interface ChatEvent {
	readonly topic: 'chat';
	readonly action: EventAction;
	readonly message: Utterance;
}

/** Someone supported the channel. */
export interface ActivityEvent {
	readonly topic: 'activity';
	readonly action: EventAction;
	readonly entry: ActivityEntry;
}

/**
 * One platform's live state changed.
 *
 * One platform rather than the whole `LiveStatus`: a stream going live on Twitch says nothing
 * about TikTok, and sending the full status would mean refetching every platform to answer an event
 * about one of them. A client merges this into the status it already has.
 */
export interface LiveEvent {
	readonly topic: 'live';
	readonly action: EventAction;
	readonly platform: string;
	readonly state: PlatformState;
}

export type SiteEvent = ChatEvent | ActivityEvent | LiveEvent;

/** Whether a string names a topic. For validating what a client asked for. */
export function isTopic(value: string): value is Topic {
	return (TOPICS as readonly string[]).includes(value);
}

/**
 * The topics a `?topics=` query asked for.
 *
 * Unknown names are dropped rather than refused: a client built against a later version asking for
 * a topic this deployment does not have should get the ones it does, not a 400 and no stream at
 * all. An empty or absent parameter means every topic, which is what a debugging `curl` wants.
 *
 * Returned in {@link TOPICS} order with duplicates removed, so the same request always produces the
 * same subscription set however the client spelled it.
 */
export function topicsFrom(value: string | null): readonly Topic[] {
	if (value === null || value.trim() === '') return TOPICS;

	const asked = new Set(value.split(',').map((name) => name.trim()));
	const known = TOPICS.filter((topic) => asked.has(topic));

	// Every name was one this deployment does not know. Falling back to everything would be a
	// surprise, so this is the one case that gets an empty subscription — a connected stream that
	// stays silent, which a client can detect.
	return known;
}
