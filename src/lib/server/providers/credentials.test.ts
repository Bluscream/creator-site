/**
 * Where a provider's credential comes from, and in what order.
 *
 * The order is the whole behaviour: a linked account wins, the environment is the fallback. Getting
 * it backwards would mean somebody who has just linked their Twitch account still being read through
 * the stale variable in the `.env` file they forgot about — which looks like the link silently not
 * working, and is the kind of thing that costs an afternoon.
 *
 * `connections.ts` is mocked rather than backed by a database here. This module's job is the
 * *decision*, and `connections.test.ts` already covers the storage; a real database would make these
 * tests about both and fail for either reason.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credential as StoredCredential } from '#lib/server/connections.js';

/** What the environment holds. Mocked so a developer's own `.env` cannot change a result. */
const env = vi.hoisted(() => {
	const state: {
		synchraToken: string | undefined;
		synchraChannel: string | undefined;
		twitchId: string | undefined;
		twitchSecret: string | undefined;
	} = {
		synchraToken: undefined,
		synchraChannel: undefined,
		twitchId: undefined,
		twitchSecret: undefined
	};

	return state;
});

vi.mock('$app/env/private', () => ({
	get SYNCHRA_TOKEN() {
		return env.synchraToken;
	},
	get SYNCHRA_CHANNEL_ID() {
		return env.synchraChannel;
	},
	get TWITCH_CLIENT_ID() {
		return env.twitchId;
	},
	get TWITCH_CLIENT_SECRET() {
		return env.twitchSecret;
	}
}));

/** What is linked, by platform. */
const linked = vi.hoisted(() => {
	const state: { byPlatform: Record<string, unknown> } = { byPlatform: {} };

	return state;
});

vi.mock('#lib/server/connections.js', () => ({
	credentialFor: (platform: string) => linked.byPlatform[platform] ?? null
}));

const { credentialsFor } = await import('./credentials.js');

/** A stored credential as `connections.credentialFor` returns one. */
function connection(overrides: Partial<StoredCredential> = {}): StoredCredential {
	return {
		platform: 'twitch',
		platformAccountId: '12345',
		handle: 'somebody',
		accessToken: 'a-linked-token',
		refreshToken: 'a-refresh-token',
		expiresAt: null,
		scopes: ['user:read:email'],
		...overrides
	};
}

beforeEach(() => {
	env.synchraToken = undefined;
	env.synchraChannel = undefined;
	env.twitchId = undefined;
	env.twitchSecret = undefined;
	linked.byPlatform = {};
});

describe('with nothing configured at all', () => {
	it('is an empty credential rather than a throw', () => {
		// A fresh install is a supported state. The provider reports itself unusable; the page renders.
		expect(credentialsFor('twitch')).toStrictEqual({});
	});

	it('is empty for a provider nobody implements', () => {
		// A configuration naming a provider that is not installed degrades to "not configured" instead
		// of taking the page down.
		expect(credentialsFor('myspace')).toStrictEqual({});
	});
});

describe('from the environment', () => {
	it('reads the Synchra token and channel', () => {
		env.synchraToken = 'a-synchra-token';
		env.synchraChannel = 'a-channel';

		expect(credentialsFor('synchra')).toStrictEqual({
			token: 'a-synchra-token',
			channelId: 'a-channel'
		});
	});

	it('reads the Twitch application', () => {
		env.twitchId = 'a-client-id';
		env.twitchSecret = 'a-client-secret';

		expect(credentialsFor('twitch')).toStrictEqual({
			clientId: 'a-client-id',
			clientSecret: 'a-client-secret'
		});
	});

	it('leaves an unset variable absent rather than present and undefined', () => {
		// `exactOptionalPropertyTypes` distinguishes the two, and a provider writing `'token' in
		// credential` should get the answer an operator would expect.
		env.twitchId = 'a-client-id';

		expect('clientSecret' in credentialsFor('twitch')).toBe(false);
	});
});

describe('from a linked account', () => {
	it('uses the linked token', () => {
		linked.byPlatform = { twitch: connection() };

		expect(credentialsFor('twitch').token).toBe('a-linked-token');
	});

	it('carries the platform account id, which is whose data to read', () => {
		linked.byPlatform = { twitch: connection() };

		expect(credentialsFor('twitch').channelId).toBe('12345');
	});

	it('never carries the refresh token, which no provider read path needs', () => {
		// Refreshing is `connections.refreshCredential`'s business. A refresh token handed to a reader
		// is a long-lived credential in a place that only needed a short-lived one.
		linked.byPlatform = { twitch: connection() };

		expect(JSON.stringify(credentialsFor('twitch'))).not.toContain('a-refresh-token');
	});

	it('works for a platform the environment has no variables for', () => {
		// Which is the point: a new platform needs a link, not a release that adds two env vars.
		linked.byPlatform = { kick: connection({ platform: 'kick', accessToken: 'a-kick-token' }) };

		expect(credentialsFor('kick')).toMatchObject({ token: 'a-kick-token' });
	});

	it('leaves the token absent for a link that carries no secret', () => {
		// A platform whose reads need no credential. The account id is still worth having.
		linked.byPlatform = {
			bluesky: connection({ platform: 'bluesky', accessToken: null, refreshToken: null })
		};

		const credential = credentialsFor('bluesky');

		expect('token' in credential).toBe(false);
		expect(credential.channelId).toBe('12345');
	});
});

describe('the order between them', () => {
	it('prefers the linked account over the environment', () => {
		// The behaviour this module exists for. Backwards, it reads as the link silently not working.
		env.twitchId = 'a-client-id';
		env.twitchSecret = 'a-client-secret';
		linked.byPlatform = { twitch: connection() };

		expect(credentialsFor('twitch').token).toBe('a-linked-token');
	});

	it('still carries the application credentials alongside a linked account', () => {
		// A client id identifies the *application*; an access token identifies the person. Twitch wants
		// both on every Helix call, so a link merges with them rather than replacing them.
		env.twitchId = 'a-client-id';
		env.twitchSecret = 'a-client-secret';
		linked.byPlatform = { twitch: connection() };

		expect(credentialsFor('twitch')).toMatchObject({
			token: 'a-linked-token',
			clientId: 'a-client-id',
			clientSecret: 'a-client-secret'
		});
	});

	it('falls back to the environment when nothing is linked for that platform', () => {
		env.twitchId = 'a-client-id';
		linked.byPlatform = { kick: connection({ platform: 'kick' }) };

		expect(credentialsFor('twitch')).toStrictEqual({ clientId: 'a-client-id' });
	});

	it('does not merge application credentials into an unrelated platform', () => {
		// Twitch's client id is Twitch's. Handing it to Kick would be a credential sent to the wrong
		// host.
		env.twitchId = 'a-client-id';
		env.twitchSecret = 'a-client-secret';
		linked.byPlatform = { kick: connection({ platform: 'kick', accessToken: 'a-kick-token' }) };

		expect(credentialsFor('kick')).toStrictEqual({
			token: 'a-kick-token',
			channelId: '12345'
		});
	});

	it('does not let a linked account on one platform satisfy another', () => {
		linked.byPlatform = { twitch: connection() };

		expect(credentialsFor('synchra')).toStrictEqual({});
	});
});
