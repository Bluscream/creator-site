/**
 * The client side of the live feed: fetch the backlog, then stay current over SSE.
 *
 * This is the piece that makes the transport worth having. A page calls {@link liveFeed} once, gets
 * reactive state, and never writes a `setInterval` — which is what the PHP had, at four seconds,
 * per open tab.
 *
 * ### Fetch first, then stream
 *
 * `EventSource` only ever delivers what happens *next*, so a page that only streamed would start
 * empty and stay empty on a quiet channel. The backlog comes from `/api/chat` — whose rows are the
 * same shape the stream delivers, deliberately — and the stream takes over from there.
 *
 * There is a window between the two in which an event could be missed. It is handled by merging on
 * `id` rather than appending: a message that arrives in both lands once, and one that arrives only
 * over the stream is added. The alternative, a cursor handshake, would be a protocol to maintain
 * for a gap measured in one request.
 *
 * ### Reconnection is the browser's
 *
 * `EventSource` reconnects on its own with the interval the server sent, and replays
 * `Last-Event-ID`. Nothing here implements backoff. What it does do is refetch the backlog when a
 * connection is re-established, because a long disconnection may have outrun the replay buffer.
 *
 * ### Runes, so this is a `.svelte.ts` file
 *
 * `$state` outside a component needs the `.svelte.ts` extension for the compiler to process it.
 * The state is returned as an object with getters rather than as plain properties, so a consumer
 * destructuring it does not quietly take a snapshot and wonder why the log never updates.
 */

import { browser } from '$app/env';
import type { ActivityEntry } from '#lib/activity.js';
import type { ChatMessage, ChatResult } from '#lib/chat.js';
import type { ActivityResult } from '#lib/activity.js';
import type { SiteEvent, Topic } from '#lib/events.js';

/** What a feed exposes to a page. */
export interface LiveFeed {
	readonly messages: readonly ChatMessage[];
	readonly activity: readonly ActivityEntry[];
	/** False while the first fetch is in flight, so a page can tell "empty" from "not yet". */
	readonly ready: boolean;
	/** True when the backlog fetch said the provider cannot read this feed. */
	readonly unavailable: boolean;
	/** Whether the event stream is currently open. A page may show this; it need not. */
	readonly streaming: boolean;
	/** Stops the stream and the refetching. A page's `onDestroy`. */
	readonly stop: () => void;
}

export interface LiveFeedOptions {
	/** Which topics to stream. Chat alone, for a chat-only overlay. */
	readonly topics?: readonly Topic[];
	/** How many messages to keep on screen. Older ones are dropped as new ones arrive. */
	readonly limit?: number;
	/** Whether to merge support events into the chat log. */
	readonly events?: boolean;
}

const DEFAULT_LIMIT = 60;

/**
 * A response body as it actually arrives, rather than as the happy path describes it.
 *
 * `ChatResult` says `messages` is always there, and for an `ok: true` response it is. But the same
 * endpoint answers `{ ok: false, reason: 'not_configured', configured: false }` with no payload at
 * all, and a `JSON.parse` result is not a typed call — asserting the full type here would make the
 * guards below look redundant to the compiler and to the linter while being exactly what stops a
 * `.slice()` on `undefined`.
 *
 * So the assertion is honest about it, and every field is read as optional.
 */
type Parsed<T> = Partial<T>;

/**
 * Starts a feed.
 *
 * Safe to call during SSR: it does nothing until it is in a browser, so a page can call it at the
 * top level and render its empty state on the server.
 */
export function liveFeed(options: LiveFeedOptions = {}): LiveFeed {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const wantsEvents = options.events ?? true;
	const topics =
		options.topics ?? (wantsEvents ? (['chat', 'activity'] as const) : (['chat'] as const));

	let messages = $state<readonly ChatMessage[]>([]);
	let activity = $state<readonly ActivityEntry[]>([]);
	let ready = $state(false);
	let unavailable = $state(false);
	let streaming = $state(false);

	let stream: EventSource | null = null;
	let stopped = false;

	/**
	 * Adds or replaces a message, keeping the log in time order and within the limit.
	 *
	 * By `id`, so the overlap between the backlog and the stream costs a replacement rather than a
	 * duplicate — and so an edited message updates in place instead of appearing twice.
	 */
	function upsertMessage(message: ChatMessage): void {
		const without = messages.filter((existing) => existing.id !== message.id);
		const merged = [...without, message].sort((a, b) => a.created_at.localeCompare(b.created_at));

		messages = merged.slice(-limit);
	}

	function removeMessage(id: string): void {
		messages = messages.filter((existing) => existing.id !== id);
	}

	function upsertActivity(entry: ActivityEntry): void {
		const without = activity.filter((existing) => existing.id !== entry.id);
		const merged = [...without, entry].sort((a, b) => a.created_at.localeCompare(b.created_at));

		activity = merged.slice(-limit);
	}

	async function fetchBacklog(): Promise<void> {
		try {
			const [chat, support] = await Promise.all([
				fetch('/api/chat').then((response) => response.json() as Promise<Parsed<ChatResult>>),
				wantsEvents
					? fetch('/api/activity').then(
							(response) => response.json() as Promise<Parsed<ActivityResult>>
						)
					: Promise.resolve(null)
			]);

			if (stopped) return;

			messages = (chat.messages ?? []).slice(-limit);
			// `=== false` and not `!== true`: an explicit refusal is the only thing that should say
			// "unavailable". An absent field means the envelope carried no payload at all — a
			// `not_configured` response — and that is a page with nothing in it, not a broken feed.
			unavailable = chat.available === false;

			if (support !== null) activity = (support.activities ?? []).slice(-limit);
		} catch {
			// A failed backlog fetch is not fatal: the stream may still deliver, and the page shows
			// its empty state meanwhile. Retrying here would need a backoff, and the next reconnect
			// already refetches.
		} finally {
			if (!stopped) ready = true;
		}
	}

	function handle(event: MessageEvent<string>): void {
		let payload: SiteEvent;

		try {
			payload = JSON.parse(event.data) as SiteEvent;
		} catch {
			// A frame this version cannot parse is one frame, not a reason to tear down the stream.
			return;
		}

		if (payload.topic === 'chat') {
			if (payload.action === 'deleted') removeMessage(payload.message.id);
			else upsertMessage(payload.message);
		} else if (payload.topic === 'activity' && wantsEvents) {
			if (payload.action !== 'deleted') upsertActivity(payload.entry);
		}
	}

	function connect(): void {
		if (stopped) return;

		stream = new EventSource(`/api/events?topics=${topics.join(',')}`);

		stream.addEventListener('open', () => {
			const reconnected = streaming;

			streaming = true;

			// A reconnection may have outrun the server's replay buffer, so the backlog is the only
			// thing that can be trusted to close the gap. Skipped on the first open, where the
			// backlog fetch is already in flight.
			if (reconnected) void fetchBacklog();
		});

		stream.addEventListener('error', () => {
			// `EventSource` reconnects by itself; this only records that it is not connected right
			// now, so a page can say so.
			streaming = false;
		});

		for (const topic of topics) stream.addEventListener(topic, handle as EventListener);
	}

	if (browser) {
		void fetchBacklog();
		connect();
	}

	return {
		get messages() {
			return messages;
		},
		get activity() {
			return activity;
		},
		get ready() {
			return ready;
		},
		get unavailable() {
			return unavailable;
		},
		get streaming() {
			return streaming;
		},
		stop: () => {
			stopped = true;
			stream?.close();
			stream = null;
			streaming = false;
		}
	};
}

/**
 * Chat messages and support events in one list, in time order.
 *
 * A plain function rather than part of the feed because it is a *view*: the chat page interleaves
 * them, a toast panel wants the events alone, and an overlay with `events=0` wants only the chat.
 * Merging in the feed would make the second two filter a list that had already been built.
 */
export type FeedRow =
	| { readonly kind: 'message'; readonly at: string; readonly message: ChatMessage }
	| { readonly kind: 'activity'; readonly at: string; readonly entry: ActivityEntry };

export function interleave(
	messages: readonly ChatMessage[],
	activity: readonly ActivityEntry[]
): readonly FeedRow[] {
	const rows: FeedRow[] = [
		...messages.map((message) => ({ kind: 'message' as const, at: message.created_at, message })),
		...activity.map((entry) => ({ kind: 'activity' as const, at: entry.created_at, entry }))
	];

	// `localeCompare` on an ISO 8601 string at a fixed offset is a lexical comparison that happens
	// to be chronological, which is why `atom()` normalises every timestamp to exactly that shape.
	return rows.sort((a, b) => a.at.localeCompare(b.at));
}
