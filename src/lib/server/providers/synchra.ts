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

import { AuthenticationError, AuthorizationError, Synchra, SynchraError } from 'synchra-ts';
import { atom, offlinePlatform, watchUrl } from '#lib/live.js';
import type { LiveStatus, PlatformState } from '#lib/live.js';
import { ServiceFailure, notConfigured } from '#lib/server/failure.js';
import type { Credential } from '#lib/server/providers/credentials.js';
import type {
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
