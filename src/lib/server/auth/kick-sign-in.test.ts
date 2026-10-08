/**
 * Linking a Kick account.
 *
 * What is tested here is the part that is Kick's and not shared: introspection, the three refusals
 * it performs, and the four places Kick's shapes differ from Twitch's in a way that would be a bug
 * if copied across — an absolute `exp` rather than a duration, a `token_type` that means
 * user-or-app rather than `Bearer`, a numeric `user_id`, and an `email` that must not be kept.
 *
 * The protocol itself is `oauth2.test.ts`'s, and the OAuth round trip is `flow.test.ts`'s against a
 * stand-in provider, because none of that is Kick-specific.
 *
 * The environment is mocked rather than read: a test that read this project's own `.env` would pass
 * on one machine and put a live client id in an assertion.
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
	get KICK_CLIENT_ID() {
		return env.id;
	},
	get KICK_CLIENT_SECRET() {
		return env.secret;
	}
}));

const { kickSignIn, verifyKickToken } = await import('./kick-sign-in.js');
const { SignInFailure } = await import('./sign-in-provider.js');

const REDIRECT = 'https://site.example/auth/kick/callback';

/** One stubbed response. */
interface Reply {
	readonly status?: number;
	readonly body?: unknown;
	readonly fails?: boolean;
}

/** Every request the code under test made. */
interface Call {
	readonly url: string;
	readonly method: string;
	readonly authorization: string | undefined;
}

let calls: Call[];

/** Answers by what the url contains, so a test says what it varies rather than restating a URL. */
function answering(replies: Readonly<Record<string, Reply>>): void {
	vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers ?? {});

		calls.push({
			url,
			method: init?.method ?? 'GET',
			authorization: headers.get('authorization') ?? undefined
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

/** An introspection body for a live user token of our own application. */
function introspection(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		data: {
			active: true,
			client_id: 'our-client-id',
			token_type: 'user',
			scope: 'user:read channel:read',
			exp: 1_771_046_347,
			...extra
		},
		message: 'OK'
	};
}

/** A `public/v1/users` body, including the email Kick sends whether or not anybody wanted it. */
function users(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		data: [
			{
				user_id: 1_234_567,
				name: 'Someone',
				email: 'someone@example.invalid',
				profile_picture: 'https://files.kick.com/images/user/1234567/profile.jpg',
				...extra
			}
		],
		message: 'OK'
	};
}

/** Both endpoints answering normally. */
function working(extra: Readonly<Record<string, Reply>> = {}): void {
	answering({
		'oauth/token/introspect': { body: introspection() },
		'public/v1/users': { body: users() },
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

describe('starting a sign-in', () => {
	it('sends a PKCE challenge, because Kick refuses a request without one', async () => {
		// Not optional here as it is for Discord: Kick rejects an authorization request with no
		// challenge, and `S256` is the only method it accepts.
		const { url, verifier } = await kickSignIn().authorize('the-state', REDIRECT);

		expect(verifier).not.toBeNull();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).not.toBeNull();
		expect(url.toString()).not.toContain(verifier);
	});

	it('points at Kick and asks only for user:read', async () => {
		// `channel:read` is what reading the creator's channel would need, and is deliberately not
		// requested while nothing reads it.
		const { url } = await kickSignIn().authorize('s', REDIRECT);

		expect(url.origin + url.pathname).toBe('https://id.kick.com/oauth/authorize');
		expect(url.searchParams.get('scope')).toBe('user:read');
	});

	it('refuses to build a URL when nothing is configured', async () => {
		env.id = undefined;

		await expect(kickSignIn().authorize('s', REDIRECT)).rejects.toBeInstanceOf(SignInFailure);
	});
});

describe('a token that works', () => {
	it('says whose it is, with the id as a string', async () => {
		// Kick sends `user_id` as a number where Twitch sends a string. It becomes a database key, so
		// it is converted here rather than left to whatever first writes it to a row.
		working();

		const grant = await verifyKickToken('a-user-token');

		expect(grant.identity).toStrictEqual({
			provider: 'kick',
			providerUserId: '1234567',
			name: 'Someone',
			avatarUrl: 'https://files.kick.com/images/user/1234567/profile.jpg'
		});
	});

	it('never keeps the email Kick sends unasked', async () => {
		// The one that matters for this provider. `public/v1/users` returns it whether or not anything
		// wanted it, and a field read and stored "in case" is how a site ends up holding personal data
		// it never needed.
		working();

		const grant = await verifyKickToken('a-user-token');

		expect(JSON.stringify(grant)).not.toContain('someone@example.invalid');
		expect(grant.identity).not.toHaveProperty('email');
	});

	it('reads `exp` as an absolute timestamp, not as seconds remaining', async () => {
		// Twitch's `expires_in` is a duration and Kick's `exp` is a date. Treating one as the other
		// puts every link's expiry either in 1970 or tens of thousands of years out.
		working();

		expect((await verifyKickToken('a-user-token')).expiresAt).toBe(1_771_046_347);
	});

	it('carries the scopes Kick says were granted', async () => {
		working();

		expect((await verifyKickToken('a-user-token')).scopes).toStrictEqual([
			'user:read',
			'channel:read'
		]);
	});

	it('has no refresh token, because a pasted one cannot have one', async () => {
		working();

		expect((await verifyKickToken('a-user-token')).refreshToken).toBeNull();
	});

	it('introspects with POST and a Bearer header, as Kick documents', async () => {
		// A GET here answers 405, which reads like a wrong URL rather than a wrong method.
		working();
		await verifyKickToken('a-user-token');

		const introspect = calls.find((call) => call.url.includes('introspect'));

		expect(introspect?.method).toBe('POST');
		expect(introspect?.authorization).toBe('Bearer a-user-token');
	});
});

describe('a token this site must refuse', () => {
	it('refuses an app token, which belongs to no account', async () => {
		// `token_type` here is `user` or `app`, not `Bearer`. An app token authenticates the
		// application, so storing one as somebody's link would attach a site-wide credential to a
		// personal connection.
		answering({ 'oauth/token/introspect': { body: introspection({ token_type: 'app' }) } });

		await expect(verifyKickToken('a-user-token')).rejects.toThrow(/application rather than/);
	});

	it('refuses an inactive token', async () => {
		answering({ 'oauth/token/introspect': { body: introspection({ active: false }) } });

		await expect(verifyKickToken('a-user-token')).rejects.toThrow(/may have expired/);
	});

	it('refuses one minted for a different application', async () => {
		answering({
			'oauth/token/introspect': { body: introspection({ client_id: 'somebody-elses-id' }) }
		});

		await expect(verifyKickToken('a-user-token')).rejects.toThrow(/different application/);
	});

	it('accepts one where Kick names no application at all', async () => {
		// Kick's own documentation shows `client_id` empty in its example response. A strict check
		// would refuse every token on an install where Kick does not populate it — a worse failure
		// than the one it guards against — so the check applies only when there is a value.
		answering({
			'oauth/token/introspect': { body: introspection({ client_id: '' }) },
			'public/v1/users': { body: users() }
		});

		expect((await verifyKickToken('a-user-token')).identity.providerUserId).toBe('1234567');
	});

	it('refuses an empty paste without asking Kick', async () => {
		working();

		await expect(verifyKickToken('   ')).rejects.toBeInstanceOf(SignInFailure);
		expect(calls).toEqual([]);
	});

	it('says Kick is unreachable rather than that the token is bad', async () => {
		answering({ 'oauth/token/introspect': { fails: true } });

		await expect(verifyKickToken('a-user-token')).rejects.toThrow(/could not be reached/);
	});
});

describe('when the identity call is the one that fails', () => {
	it('fails the link, because introspection never says who', async () => {
		// Unlike Twitch, where `helix/users` is decoration over an id `/oauth2/validate` already gave.
		// Kick's introspection has no subject, so without this call there is no id to key on and a
		// "successful" link would have nothing to attach.
		answering({
			'oauth/token/introspect': { body: introspection() },
			'public/v1/users': { fails: true }
		});

		await expect(verifyKickToken('a-user-token')).rejects.toBeInstanceOf(SignInFailure);
	});

	it('refuses a user list with nobody in it', async () => {
		answering({
			'oauth/token/introspect': { body: introspection() },
			'public/v1/users': { body: { data: [], message: 'OK' } }
		});

		await expect(verifyKickToken('a-user-token')).rejects.toBeInstanceOf(SignInFailure);
	});

	it('refuses a user id that is not one', async () => {
		answering({
			'oauth/token/introspect': { body: introspection() },
			'public/v1/users': { body: users({ user_id: 1.5 }) }
		});

		await expect(verifyKickToken('a-user-token')).rejects.toBeInstanceOf(SignInFailure);
	});

	it('still links without a name or an avatar', async () => {
		answering({
			'oauth/token/introspect': { body: introspection() },
			'public/v1/users': { body: users({ name: '', profile_picture: null }) }
		});

		const grant = await verifyKickToken('a-user-token');

		expect(grant.identity).toStrictEqual({ provider: 'kick', providerUserId: '1234567' });
	});

	it('drops an avatar that is not https', async () => {
		answering({
			'oauth/token/introspect': { body: introspection() },
			'public/v1/users': { body: users({ profile_picture: 'http://elsewhere.invalid/a.png' }) }
		});

		expect((await verifyKickToken('a-user-token')).identity).not.toHaveProperty('avatarUrl');
	});
});

describe('what a failure message may contain', () => {
	it.each([
		['a rejected token', { 'oauth/token/introspect': { status: 401 } }],
		[
			'a server error quoting the request',
			{
				'oauth/token/introspect': {
					status: 500,
					body: { token: 'a-user-token', client_secret: 'our-client-secret' }
				}
			}
		],
		[
			'a wrong application',
			{ 'oauth/token/introspect': { body: introspection({ client_id: 'somebody-elses-id' }) } }
		]
	])('never repeats the token or the credentials: %s', async (_name, replies) => {
		answering(replies);

		// These requests carry a credential, and an error response from an API gateway can quote the
		// request that produced it.
		const failure = await verifyKickToken('a-user-token').catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain('a-user-token');
		expect((failure as Error).message).not.toContain('our-client-id');
		expect((failure as Error).message).not.toContain('our-client-secret');
	});
});
