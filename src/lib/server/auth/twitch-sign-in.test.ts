/**
 * Checking a Twitch token somebody pasted.
 *
 * The OAuth half is covered by `flow.test.ts` against a stand-in provider, because none of it is
 * Twitch-specific. What *is* Twitch-specific, and is what this file covers, is validation: the
 * application check, the two `Authorization` spellings, the expiry convention, and what an error
 * message is allowed to contain.
 *
 * `fetch` is stubbed rather than a real Twitch call. The environment is mocked too, deliberately:
 * this project's own `.env` has real Twitch credentials, and a test that read them would pass on
 * one machine, hit the network, and put a live client id in an assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
	const state: { id: string | undefined; secret: string | undefined } = {
		id: 'our-client-id',
		secret: 'our-client-secret'
	};

	return state;
});

vi.mock('$app/env/private', () => ({
	get TWITCH_CLIENT_ID() {
		return env.id;
	},
	get TWITCH_CLIENT_SECRET() {
		return env.secret;
	}
}));

const { verifyTwitchToken } = await import('./twitch-sign-in.js');
const { SignInFailure } = await import('./sign-in-provider.js');

/** One stubbed response. */
interface Reply {
	readonly status?: number;
	readonly body?: unknown;

	/** For the transport-failure case: the request rejects rather than answering. */
	readonly fails?: boolean;
}

/** Every request the code under test made. */
interface Call {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly clientId: string | undefined;
}

let calls: Call[];

/**
 * Answers `/oauth2/validate` and `helix/users`, by what the url contains.
 *
 * Keyed on a substring rather than the exact url so a test says what it is varying — "validate
 * answers 401" — without restating the endpoint.
 */
function answering(replies: Readonly<Record<string, Reply>>): void {
	vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers ?? {});

		calls.push({
			url,
			authorization: headers.get('authorization') ?? undefined,
			clientId: headers.get('client-id') ?? undefined
		});

		const key = Object.keys(replies).find((part) => url.includes(part));
		const reply = key === undefined ? undefined : replies[key];

		if (reply?.fails === true) return Promise.reject(new Error('network is down'));

		const status = reply?.status ?? 200;

		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(reply?.body ?? {})
		} as Response);
	});
}

/** A `/oauth2/validate` body for our own application. */
function validation(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		client_id: 'our-client-id',
		login: 'someone',
		user_id: '141981764',
		scopes: [],
		expires_in: 3600,
		...extra
	};
}

/** Both endpoints answering normally. */
function working(extra: Readonly<Record<string, Reply>> = {}): void {
	answering({
		'oauth2/validate': { body: validation() },
		'helix/users': {
			body: {
				data: [
					{
						id: '141981764',
						display_name: 'Someone',
						profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abc.png'
					}
				]
			}
		},
		...extra
	});
}

beforeEach(() => {
	calls = [];
	env.id = 'our-client-id';
	env.secret = 'our-client-secret';
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a token that works', () => {
	it('says whose it is', async () => {
		working();

		const grant = await verifyTwitchToken('a-user-token');

		expect(grant.identity).toStrictEqual({
			provider: 'twitch',
			providerUserId: '141981764',
			name: 'Someone',
			avatarUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abc.png'
		});
	});

	it('stores the token it actually proved, not the string it was handed', async () => {
		// A paste picks up a newline or a space. Storing the untrimmed value would store something
		// that was never validated, and `Bearer a-user-token\n` is a 401 on the next call.
		working();

		const grant = await verifyTwitchToken('  a-user-token\n');

		expect(grant.accessToken).toBe('a-user-token');
	});

	it('carries the scopes Twitch says were granted, not the ones that were asked for', async () => {
		answering({
			'oauth2/validate': {
				body: validation({ scopes: ['user:read:chat', 'channel:read:subscriptions'] })
			},
			'helix/users': { body: { data: [{ id: '141981764' }] } }
		});

		const grant = await verifyTwitchToken('a-user-token');

		expect(grant.scopes).toStrictEqual(['user:read:chat', 'channel:read:subscriptions']);
	});

	it('has no refresh token, because a pasted one cannot have one', async () => {
		// Nobody can mint a refresh token from an access token, so this link lapses and has to be
		// pasted again. `Connection.refreshable` is how the account page says so.
		working();

		expect((await verifyTwitchToken('a-user-token')).refreshToken).toBeNull();
	});

	it('turns the remaining seconds into a timestamp', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));

		try {
			working();

			const grant = await verifyTwitchToken('a-user-token');

			expect(grant.expiresAt).toBe(Math.floor(Date.parse('2026-10-08T01:00:00.000Z') / 1000));
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats zero seconds as never expiring, not as expired in 1970', async () => {
		// Twitch sends `expires_in: 0` for a token type it does not expire. Arithmetic on it would
		// put the expiry at the epoch and make every such link render as lapsed forever.
		answering({
			'oauth2/validate': { body: validation({ expires_in: 0 }) },
			'helix/users': { body: { data: [{ id: '141981764' }] } }
		});

		expect((await verifyTwitchToken('a-user-token')).expiresAt).toBeNull();
	});

	it('uses the two Authorization spellings each endpoint actually wants', async () => {
		// `/oauth2/validate` wants `OAuth <token>`; Helix wants `Bearer <token>`. The same token, and
		// the wrong spelling is a 401 that reads like a bad credential.
		working();
		await verifyTwitchToken('a-user-token');

		const validate = calls.find((call) => call.url.includes('oauth2/validate'));
		const users = calls.find((call) => call.url.includes('helix/users'));

		expect(validate?.authorization).toBe('OAuth a-user-token');
		expect(users?.authorization).toBe('Bearer a-user-token');
		expect(users?.clientId).toBe('our-client-id');
	});
});

describe('a token this site must refuse', () => {
	it('refuses one minted for a different application', async () => {
		// The property this check exists for. It is a perfectly valid Twitch token — which is the
		// problem: its scopes were granted to somebody else's client id, and this site can neither
		// reason about them nor revoke it.
		answering({ 'oauth2/validate': { body: validation({ client_id: 'somebody-elses-id' }) } });

		await expect(verifyTwitchToken('a-user-token')).rejects.toThrow(/different application/);
	});

	it('refuses an empty paste without asking Twitch', async () => {
		working();

		await expect(verifyTwitchToken('   ')).rejects.toBeInstanceOf(SignInFailure);
		expect(calls).toEqual([]);
	});

	it('reports a rejected token as expired rather than as a site failure', async () => {
		answering({ 'oauth2/validate': { status: 401 } });

		await expect(verifyTwitchToken('a-user-token')).rejects.toThrow(/may have expired/);
	});

	it('refuses a validation response with no user id', async () => {
		answering({ 'oauth2/validate': { body: { client_id: 'our-client-id' } } });

		await expect(verifyTwitchToken('a-user-token')).rejects.toBeInstanceOf(SignInFailure);
	});

	it('refuses a user id that is not one', async () => {
		// It becomes a database key and is compared against rows, so it is checked rather than taken.
		answering({ 'oauth2/validate': { body: validation({ user_id: '../../etc/passwd' }) } });

		await expect(verifyTwitchToken('a-user-token')).rejects.toBeInstanceOf(SignInFailure);
	});

	it('says Twitch is unreachable rather than that the token is bad', async () => {
		answering({ 'oauth2/validate': { fails: true } });

		await expect(verifyTwitchToken('a-user-token')).rejects.toThrow(/could not be reached/);
	});
});

describe('what a failure message may contain', () => {
	it.each([
		['a rejected token', { 'oauth2/validate': { status: 401 } }],
		['a server error', { 'oauth2/validate': { status: 500, body: { token: 'a-user-token' } } }],
		[
			'a wrong application',
			{ 'oauth2/validate': { body: validation({ client_id: 'somebody-elses-id' }) } }
		]
	])('never repeats the token or the client id: %s', async (_name, replies) => {
		answering(replies);

		// The one that matters: these requests carry a credential, and an error response from an API
		// gateway can quote the request that produced it.
		const failure = await verifyTwitchToken('a-user-token').catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain('a-user-token');
		expect((failure as Error).message).not.toContain('our-client-id');
		expect((failure as Error).message).not.toContain('our-client-secret');
	});
});

describe('when only the decoration fails', () => {
	it('still links, with the login as the name', async () => {
		// Knowing who is the requirement; a display name and an avatar are decoration, and refusing a
		// link because a decorative request timed out would be the wrong trade.
		answering({
			'oauth2/validate': { body: validation() },
			'helix/users': { fails: true }
		});

		const grant = await verifyTwitchToken('a-user-token');

		expect(grant.identity).toStrictEqual({
			provider: 'twitch',
			providerUserId: '141981764',
			name: 'someone'
		});
	});

	it('falls back when Helix answers with no users', async () => {
		answering({
			'oauth2/validate': { body: validation() },
			'helix/users': { body: { data: [] } }
		});

		expect((await verifyTwitchToken('a-user-token')).identity.name).toBe('someone');
	});

	it('leaves the name off entirely when the login is not a login', async () => {
		answering({
			'oauth2/validate': { body: validation({ login: 'not a valid login!' }) },
			'helix/users': { body: { data: [] } }
		});

		expect((await verifyTwitchToken('a-user-token')).identity).not.toHaveProperty('name');
	});

	it('drops an avatar that is not https', async () => {
		// It ends up in an `<img src>` on the admin, which is a request every visitor to that page
		// makes to whatever host it names.
		answering({
			'oauth2/validate': { body: validation() },
			'helix/users': {
				body: { data: [{ id: '141981764', profile_image_url: 'http://elsewhere.invalid/a.png' }] }
			}
		});

		expect((await verifyTwitchToken('a-user-token')).identity).not.toHaveProperty('avatarUrl');
	});
});
