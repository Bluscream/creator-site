/**
 * Recent chat, cached, from whichever provider this deployment uses.
 *
 * Ported from `Feed::chat()`. Like `live.ts` it knows nothing about Synchra, and for the same
 * reason: a deployment might read chat through Twitch EventSub or a YouTube live-chat poll.
 *
 * The 5-second TTL is short because chat is the one feed where lag is visible, and it still means
 * one upstream call per 5 seconds no matter how many people have the popup open.
 */

import { NO_CHAT } from '#lib/chat.js';
import type { Chat, ChatResult } from '#lib/chat.js';
import { Cache } from '#lib/server/cache.js';
import { chatProvider } from '#lib/server/providers/registry.js';

const CACHE_KEY = 'chat';

/** 5 seconds, as in the PHP. */
const TTL = 5;

/** 40 messages, as in the PHP: enough to fill the popup on open without a second request. */
export const CHAT_LIMIT = 40;

export interface ChatOptions {
	readonly cache?: Cache;
	readonly force?: boolean;
	readonly provider?: string;
	/** How many messages to ask for. Defaults to {@link CHAT_LIMIT}. */
	readonly limit?: number;
}

export async function chat(options: ChatOptions = {}): Promise<ChatResult> {
	const cache = options.cache ?? new Cache();
	const limit = options.limit ?? CHAT_LIMIT;

	const entry = await cache.remember<Chat>(
		CACHE_KEY,
		TTL,
		// Resolved inside the refresh, so a cache hit needs no provider at all.
		() => chatProvider(options.provider).chat(limit),
		{ force: options.force ?? false }
	);

	// A failed refresh reports the cache's own error as the reason, because that is the only
	// explanation there is — the provider never got as far as having an opinion.
	return {
		...(entry.data ?? { ...NO_CHAT, reason: entry.error }),
		age: Math.max(0, entry.age),
		stale: entry.stale
	};
}
