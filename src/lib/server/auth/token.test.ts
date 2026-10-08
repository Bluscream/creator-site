/**
 * Renewing a linked account's token before it stops working.
 *
 * The behaviour under test is a decision about *when*, so the clock is fake and the stored expiry is
 * the input. The database and the platform registry are mocked: this file is about the rule, and the
 * storage and the provider each have their own tests.
 *
 * One property is asserted over and over on purpose — that nothing returns, logs or reports a token.
 * This is the only module in the project whose whole job is to hand one out, which makes it the one
 * most likely to leak it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credential } from '../connections.js';
import type { OAuth2Tokens } from './oauth2.js';

/** Unix seconds for the frozen clock below. */
const NOW = Math.floor(Date.parse('2026-10-08T12:00:00.000Z') / 1000);

const state = vi.hoisted(() => {
	const value: {
		credential: unknown;
		refresh: ((token: string) => Promise<unknown>) | undefined;
		stored: { id: string; tokens: unknown }[];
		storeSucceeds: boolean;
		logged: { level: string; fields: unknown; message: string }[];
	} = {
		credential: null,
		refresh: undefined,
		stored: [],
		storeSucceeds: true,
		logged: []
	};

	return value;
});

vi.mock('../connections.js', () => ({
	credentialFor: () => state.credential,
	refreshCredential: (id: string, tokens: unknown) => {
		state.stored.push({ id, tokens });

		return state.storeSucceeds;
	}
}));

vi.mock('../log.js', () => ({
	log: () => ({
		warn: (fields: unknown, message: string) => {
			state.logged.push({ level: 'warn', fields, message });
		},
		error: (fields: unknown, message: string) => {
			state.logged.push({ level: 'error', fields, message });
		}
	})
}));

vi.mock('./platform-registry.js', () => ({
	accountPlatform: () =>
		state.refresh === undefined ? { oauth: {} } : { oauth: { refresh: state.refresh } }
}));

const { SKEW_SECONDS, platformToken } = await import('./token.js');

/** A stored credential, as `credentialFor` returns one. */
function credential(overrides: Partial<Credential> = {}): Credential {
	return {
		id: 'a-connection-id',
		platform: 'twitch',
		platformAccountId: '12345',
		handle: 'somebody',
		accessToken: 'the-stored-token',
		refreshToken: 'the-refresh-token',
		expiresAt: NOW + 3600,
		scopes: [],
		...overrides
	};
}

/** What a successful refresh answers. */
function renewed(overrides: Partial<OAuth2Tokens> = {}): OAuth2Tokens {
	return {
		accessToken: 'the-renewed-token',
		refreshToken: 'a-new-refresh-token',
		expiresAt: NOW + 3600,
		scopes: ['a'],
		...overrides
	};
}

/** Every string this module wrote anywhere a human or a log aggregator could read it. */
function everythingLogged(): string {
	return JSON.stringify(state.logged);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW * 1000);

	state.credential = credential();
	state.refresh = () => Promise.resolve(renewed());
	state.stored = [];
	state.storeSucceeds = true;
	state.logged = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a token that is still good', () => {
	it('is handed back as it is', async () => {
		expect(await platformToken('twitch')).toBe('the-stored-token');
	});

	it('is not renewed, so a working link is not spent on a needless request', async () => {
		await platformToken('twitch');

		expect(state.stored).toStrictEqual([]);
	});

	it('is still good with a second to spare beyond the margin', async () => {
		state.credential = credential({ expiresAt: NOW + SKEW_SECONDS + 1 });

		expect(await platformToken('twitch')).toBe('the-stored-token');
	});
});

describe('a token with no expiry', () => {
	it('is treated as good rather than as unknown', async () => {
		// Twitch says "does not expire" with `expires_in: 0`, which is stored as null. Reading null as
		// "unknown, so renew" would renew on every single call for the platforms that need it least.
		state.credential = credential({ expiresAt: null });

		expect(await platformToken('twitch')).toBe('the-stored-token');
		expect(state.stored).toStrictEqual([]);
	});
});

describe('a token at or past the margin', () => {
	it.each([
		['exactly at the margin', NOW + SKEW_SECONDS],
		['inside the margin', NOW + 1],
		['expired a moment ago', NOW - 1],
		['expired long ago', NOW - 86_400]
	])('is renewed: %s', async (_name, expiresAt) => {
		state.credential = credential({ expiresAt });

		expect(await platformToken('twitch')).toBe('the-renewed-token');
	});

	it('stores the new tokens against the row they came from', async () => {
		// The row id travels on the credential rather than being looked up again, because between the
		// two reads "the most recent connection for this platform" can be a different row — and the
		// renewed token would land on the wrong one.
		state.credential = credential({ id: 'the-row-that-was-read', expiresAt: NOW });

		await platformToken('twitch');

		expect(state.stored).toStrictEqual([{ id: 'the-row-that-was-read', tokens: renewed() }]);
	});

	it('sends the stored refresh token, not the access token', async () => {
		const seen: string[] = [];

		state.credential = credential({ expiresAt: NOW });
		state.refresh = (token) => {
			seen.push(token);

			return Promise.resolve(renewed());
		};

		await platformToken('twitch');

		expect(seen).toStrictEqual(['the-refresh-token']);
	});
});

describe('when there is nothing to hand back', () => {
	it('reports nothing linked as nothing, not as an error', async () => {
		state.credential = null;

		expect(await platformToken('twitch')).toBeNull();
		expect(state.logged).toStrictEqual([]);
	});

	it('reports a link that holds no token as nothing', async () => {
		// Discord's links are like this on purpose: it asks for `identify` and nothing else, so its
		// token unlocks nothing worth storing. Not a failure, and not worth a log line on every call.
		state.credential = credential({ accessToken: null });

		expect(await platformToken('twitch')).toBeNull();
		expect(state.logged).toStrictEqual([]);
	});

	it('says a pasted token has to be connected again', async () => {
		// Nobody can mint a refresh token from an access token, so this link genuinely cannot be
		// renewed. Worth saying once it matters, because it is a thing the creator has to do.
		state.credential = credential({ expiresAt: NOW, refreshToken: null });

		expect(await platformToken('twitch')).toBeNull();
		expect(state.logged).toHaveLength(1);
		expect(everythingLogged()).toContain('connected again');
	});

	it('gives up when the platform has no refresh flow at all', async () => {
		state.credential = credential({ expiresAt: NOW });
		state.refresh = undefined;

		expect(await platformToken('twitch')).toBeNull();
	});

	it('gives up, without throwing, when the platform refuses to renew', async () => {
		// A revoked link, a changed password, a token that aged out. The caller gets null and the site
		// stays up; what it must not do is throw out of a feed render.
		state.credential = credential({ expiresAt: NOW });
		state.refresh = () => Promise.reject(new Error('Twitch would not renew that link.'));

		expect(await platformToken('twitch')).toBeNull();
		expect(state.stored).toStrictEqual([]);
	});

	it('discards a renewed token whose row has gone', async () => {
		// Unlinked in another tab while this was in flight. The token in hand would work, which is
		// exactly why it must not be returned: that is how a platform keeps being called as somebody
		// who disconnected it.
		state.credential = credential({ expiresAt: NOW });
		state.storeSucceeds = false;

		expect(await platformToken('twitch')).toBeNull();
	});
});

describe('what reaches a log', () => {
	it('never writes a token, on any path', async () => {
		// The one that matters. This is the only module whose job is to hand out a credential, which
		// makes it the one most likely to put one somewhere it is kept.
		const cases: (() => void)[] = [
			() => {
				state.credential = credential({ expiresAt: NOW, refreshToken: null });
			},
			() => {
				state.credential = credential({ expiresAt: NOW });
				state.refresh = () => Promise.reject(new Error('refused'));
			},
			() => {
				state.credential = credential({ expiresAt: NOW });
				state.storeSucceeds = false;
			},
			() => {
				state.credential = credential({ expiresAt: NOW });
				state.refresh = undefined;
			}
		];

		for (const arrange of cases) {
			state.logged = [];
			arrange();

			await platformToken('twitch');

			const written = everythingLogged();

			expect(written).not.toContain('the-stored-token');
			expect(written).not.toContain('the-refresh-token');
			expect(written).not.toContain('the-renewed-token');
			expect(written).not.toContain('a-new-refresh-token');
		}
	});

	it('names the platform, so a log line is actionable', async () => {
		state.credential = credential({ expiresAt: NOW, refreshToken: null });

		await platformToken('twitch');

		expect(everythingLogged()).toContain('twitch');
	});
});
