/**
 * The Discord sign-in provider, against a stubbed Discord.
 *
 * Not run against the live API — that needs an application, a browser and a human pressing approve,
 * which is not a unit test. What *is* tested is everything this file decides for itself: the scope
 * it asks for, the validation of a response that comes from outside the trust boundary, and the rule
 * that no failure message may carry the provider's own words.
 *
 * That last one is the reason several of these tests exist. The token exchange request contains the
 * client secret, and a rejected request can be echoed back in the response — so a message built from
 * a provider's error body is a credential on a visitor's screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The credentials the provider reads.
 *
 * Explicitly `| undefined` rather than optional: `exactOptionalPropertyTypes` distinguishes "absent"
 * from "present and undefined", and a test that unsets one is doing the second.
 */
const env = vi.hoisted(() => {
	const state: { id: string | undefined; secret: string | undefined } = {
		id: 'client-id',
		secret: 'client-secret'
	};

	return state;
});

vi.mock('$app/env/private', () => ({
	get DISCORD_CLIENT_ID() {
		return env.id;
	},
	get DISCORD_CLIENT_SECRET() {
		return env.secret;
	}
}));

import type { Callback } from './sign-in-provider.js';

const { discordSignIn } = await import('./discord-sign-in.js');
const { SignInFailure } = await import('./sign-in-provider.js');

/** The redirect a route would have derived from the request. */
const REDIRECT = 'https://site.example/auth/discord/callback';

/** An account as `/users/@me` answers. */
const ACCOUNT = {
	id: '123456789012345678',
	global_name: 'Someone',
	username: 'someone',
	avatar: 'abc123'
};

/** What the stubbed token endpoint answers unless a test says otherwise. */
let tokenResponse: () => Response;

/** What was actually sent to the token endpoint, for the tests that care. */
let tokenRequest: { authorization: string | null; body: string } | null;

/** What the stubbed identity endpoint answers unless a test says otherwise. */
let identityResponse: () => Response;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

beforeEach(() => {
	env.id = 'client-id';
	env.secret = 'client-secret';

	tokenResponse = () =>
		json({ access_token: 'an-access-token', token_type: 'Bearer', expires_in: 604_800 });
	identityResponse = () => json(ACCOUNT);

	tokenRequest = null;

	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const url = request.url;

		if (url.includes('/oauth2/token')) {
			tokenRequest = {
				authorization: request.headers.get('authorization'),
				body: await request.text()
			};

			return tokenResponse();
		}

		if (url.includes('/users/@me')) return identityResponse();

		throw new Error(`nothing stubbed for ${url}`);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('usable', () => {
	it('is true with both halves', () => {
		expect(discordSignIn().usable()).toBe(true);
	});

	it('is false with only a client id', () => {
		// An id without its secret cannot complete a token exchange, so a button offered on that basis
		// fails at the last step — after the visitor has already approved it.
		env.secret = undefined;

		expect(discordSignIn().usable()).toBe(false);
	});

	it('is false with only a secret', () => {
		env.id = undefined;

		expect(discordSignIn().usable()).toBe(false);
	});
});

/**
 * A callback as `flow.ts` builds one.
 *
 * The expected state is deliberately the same value the query carries, because this file is not
 * where that comparison is tested — `flow.ts` compares the callback's state to the cookie's, and
 * `flow.test.ts` is where a mismatch is proven to be refused.
 */
function callback(code = 'a-code'): Callback {
	return {
		params: new URLSearchParams({ code, state: 'a-state' }),
		expectedState: 'a-state',
		verifier: null,
		redirectUri: REDIRECT
	};
}

describe('authorize', () => {
	it('points at Discord', async () => {
		expect((await discordSignIn().authorize('a-state', REDIRECT)).url.origin).toBe(
			'https://discord.com'
		);
	});

	it('carries the state it was given', async () => {
		expect(
			(await discordSignIn().authorize('a-state', REDIRECT)).url.searchParams.get('state')
		).toBe('a-state');
	});

	it('asks for identify and nothing else', async () => {
		// Not `guilds`, not `email`. A scope requested is a scope the visitor has to approve and the
		// application has to be trusted with.
		expect((await discordSignIn().authorize('s', REDIRECT)).url.searchParams.get('scope')).toBe(
			'identify'
		);
	});

	it('sends the redirect it was given rather than one of its own', async () => {
		expect(
			(await discordSignIn().authorize('s', REDIRECT)).url.searchParams.get('redirect_uri')
		).toBe(REDIRECT);
	});

	it('uses PKCE, and keeps the verifier out of the URL', async () => {
		// Discord treats PKCE as optional and `arctic` skipped it. Using it anyway costs nothing and
		// binds the authorization code to this exchange, so a code that leaks through a referrer, a
		// shared screen or a proxy log cannot be redeemed by whoever picked it up.
		//
		// The verifier must not appear in the URL: the whole mechanism is that the challenge travels
		// through the browser and the verifier does not.
		const { url, verifier } = await discordSignIn().authorize('s', REDIRECT);

		expect(verifier).not.toBeNull();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).not.toBe(verifier);
		expect(url.toString()).not.toContain(verifier);
	});

	it('refuses to build a URL when nothing is configured', async () => {
		// A rejected promise rather than a synchronous throw, because building the URL became async
		// when PKCE's code challenge did — `crypto.subtle.digest` is the only SHA-256 these runtimes
		// agree on. Asserted as a rejection so a caller that forgets to await cannot pass this.
		env.id = undefined;

		await expect(discordSignIn().authorize('s', REDIRECT)).rejects.toBeInstanceOf(SignInFailure);
	});
});

describe('identify', () => {
	it('reports who signed in', async () => {
		const identity = await discordSignIn().identify(callback('a-code'));

		expect(identity).toMatchObject({ provider: 'discord', providerUserId: ACCOUNT.id });
	});

	it('prefers the display name over the username', async () => {
		expect((await discordSignIn().identify(callback('c'))).name).toBe('Someone');
	});

	it('falls back to the username when there is no display name', async () => {
		identityResponse = () => json({ ...ACCOUNT, global_name: null });

		expect((await discordSignIn().identify(callback('c'))).name).toBe('someone');
	});

	it('reports no name at all rather than an empty one', async () => {
		// `accounts.ts` falls back to the provider's own name, which is better than a blank row.
		identityResponse = () => json({ ...ACCOUNT, global_name: '', username: '' });

		expect((await discordSignIn().identify(callback('c'))).name).toBeUndefined();
	});

	it('builds the avatar URL from the id and the hash', async () => {
		expect((await discordSignIn().identify(callback('c'))).avatarUrl).toBe(
			`https://cdn.discordapp.com/avatars/${ACCOUNT.id}/abc123.png?size=64`
		);
	});

	it('reports no avatar when there is none', async () => {
		identityResponse = () => json({ ...ACCOUNT, avatar: null });

		expect((await discordSignIn().identify(callback('c'))).avatarUrl).toBeUndefined();
	});

	it('refuses an avatar hash that is not one', async () => {
		// It is interpolated into a URL that every visitor to the admin then requests, so a hash taken
		// on trust is a path somebody else chose.
		identityResponse = () => json({ ...ACCOUNT, avatar: '../../evil' });

		expect((await discordSignIn().identify(callback('c'))).avatarUrl).toBeUndefined();
	});

	it('refuses an id that is not a snowflake', async () => {
		// It becomes a database key and a URL segment.
		identityResponse = () => json({ ...ACCOUNT, id: 'not-a-snowflake' });

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});

	it('refuses a response with no id', async () => {
		identityResponse = () => json({ username: 'someone' });

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});

	it('refuses a response that is not JSON', async () => {
		identityResponse = () => new Response('<html>502</html>', { status: 200 });

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});

	it('refuses a rejected identity request', async () => {
		identityResponse = () => json({ message: '401: Unauthorized' }, 401);

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});

	it('refuses a rejected token exchange', async () => {
		tokenResponse = () => json({ error: 'invalid_grant' }, 400);

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});

	it('says starting again usually fixes a rejected exchange, because it usually does', async () => {
		tokenResponse = () => json({ error: 'invalid_grant' }, 400);

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(/again/);
	});

	it('survives an unreachable Discord', async () => {
		vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED 1.2.3.4:443')));

		await expect(discordSignIn().identify(callback('c'))).rejects.toThrow(SignInFailure);
	});
});

describe('what a failure message is allowed to contain', () => {
	/** Every message `identify` can produce, for the cases that quote something. */
	async function messageFor(run: () => Promise<unknown>): Promise<string> {
		try {
			await run();
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}

		throw new Error('nothing was thrown');
	}

	it('never repeats a rejected exchange body', async () => {
		// The exchange request carries the client secret, and an error response can echo the request
		// that produced it. This is the assertion that keeps a credential off a visitor's screen.
		tokenResponse = () =>
			json({ error: 'invalid_client', error_description: 'secret client-secret is wrong' }, 401);

		const message = await messageFor(() => discordSignIn().identify(callback('c')));

		expect(message).not.toContain('client-secret');
		expect(message).not.toContain('invalid_client');
	});

	it('never repeats an identity response body', async () => {
		identityResponse = () => json({ message: 'token an-access-token is invalid' }, 401);

		const message = await messageFor(() => discordSignIn().identify(callback('c')));

		expect(message).not.toContain('an-access-token');
	});

	it('never repeats a network error, which can carry an address', async () => {
		vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:443')));

		const message = await messageFor(() => discordSignIn().identify(callback('c')));

		expect(message).not.toContain('10.0.0.5');
	});
});

describe('how Discord is authenticated at the token endpoint', () => {
	it('sends the secret in the form body, never in a Basic header', async () => {
		// Discord accepts either, and this picks the body deliberately: RFC 6749 Appendix B has Basic
		// credentials form-urlencoded before base64, narrowing the unreserved set to letters and
		// digits, so `-` and `_` — both common in a Discord client secret — become percent escapes.
		// Discord documents Basic as plain base64 of `client_id:client_secret` and says nothing about
		// decoding. The body passes the credential through untouched, so it cannot disagree.
		await discordSignIn().identify(callback('c'));

		expect(tokenRequest?.authorization).toBeNull();

		const body = new URLSearchParams(tokenRequest?.body ?? '');

		expect(body.get('client_id')).toBe('client-id');
		expect(body.get('client_secret')).toBe('client-secret');
	});

	it('sends the PKCE verifier, which is what makes the challenge worth anything', async () => {
		// A challenge sent at authorize time and no verifier at exchange time is PKCE in appearance
		// only.
		const { verifier } = await discordSignIn().authorize('s', REDIRECT);

		await discordSignIn().identify({ ...callback('c'), verifier });

		expect(new URLSearchParams(tokenRequest?.body ?? '').get('code_verifier')).toBe(verifier);
	});
});
