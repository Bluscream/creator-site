/**
 * The OAuth 2.0 flow, at the wire.
 *
 * These assert what goes *out* and what is accepted coming *back*, because that is where the
 * providers disagree and where replacing `arctic` could have changed behaviour without changing a
 * type. Two of them are the reason this file exists at all: Discord is authenticated with HTTP Basic
 * and Twitch with the secret in the body, and Twitch's token response is not specification-shaped.
 *
 * `fetch` is stubbed rather than a real provider called. The endpoints are `https` so that nothing
 * here needs the library's insecure-transport escape hatch — a test that switches that on is a test
 * that stops checking the thing most worth checking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	OAuth2Failure,
	authorizationUrl,
	codeVerifier,
	exchangeCode,
	oauthState
} from './oauth2.js';
import type { Callback, OAuth2App } from './oauth2.js';

/** A provider that behaves as specified, authenticating with HTTP Basic. */
const BASIC: OAuth2App = {
	clientId: 'a-client-id',
	clientSecret: 'a-client-secret',
	authorizationEndpoint: 'https://provider.example/oauth2/authorize',
	tokenEndpoint: 'https://provider.example/oauth2/token',
	clientAuth: 'basic'
};

/** Twitch's shape: secret in the body, and an array-valued `scope` coming back. */
const TWITCHLIKE: OAuth2App = {
	...BASIC,
	clientAuth: 'body',
	quirks: { spaceDelimitedScope: true }
};

const REDIRECT = 'https://site.example/auth/x/callback';

/** One request the code under test made. */
interface Call {
	readonly url: string;
	readonly authorization: string | null;
	readonly body: string;
}

let calls: Call[];

/** What the stubbed token endpoint answers unless a test says otherwise. */
let reply: () => Response;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** A callback as `flow.ts` builds one: the provider's query, and the cookie's state. */
function callback(extra: Record<string, string> = {}, expectedState = 'the-state'): Callback {
	return {
		params: new URLSearchParams({ code: 'the-code', state: 'the-state', ...extra }),
		expectedState,
		verifier: null,
		redirectUri: REDIRECT
	};
}

beforeEach(() => {
	calls = [];
	reply = () =>
		json({ access_token: 'an-access-token', token_type: 'bearer', expires_in: 3600, scope: 'a b' });

	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(String(input), init);

		calls.push({
			url: request.url,
			authorization: request.headers.get('authorization'),
			body: await request.text()
		});

		return reply();
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the authorization URL', () => {
	it('carries what the provider needs to answer', async () => {
		const url = await authorizationUrl(BASIC, {
			state: 'the-state',
			redirectUri: REDIRECT,
			scopes: ['read', 'write']
		});

		expect(url.origin + url.pathname).toBe('https://provider.example/oauth2/authorize');
		expect(Object.fromEntries(url.searchParams)).toStrictEqual({
			response_type: 'code',
			client_id: 'a-client-id',
			redirect_uri: REDIRECT,
			state: 'the-state',
			scope: 'read write'
		});
	});

	it('leaves `scope` out entirely when nothing is asked for', async () => {
		// Rather than sending it empty. A provider reading `scope=` as "no scopes" and one reading it
		// as a malformed request are both in the wild; absent is unambiguous.
		const url = await authorizationUrl(BASIC, {
			state: 's',
			redirectUri: REDIRECT,
			scopes: []
		});

		expect(url.searchParams.has('scope')).toBe(false);
	});

	it('never puts the client secret in a URL the visitor will see', async () => {
		// It ends up in a browser's address bar, its history and any referrer.
		const url = await authorizationUrl(BASIC, { state: 's', redirectUri: REDIRECT, scopes: ['a'] });

		expect(url.toString()).not.toContain('a-client-secret');
	});

	it('sends a PKCE challenge, not the verifier, when there is one', async () => {
		// The point of PKCE: the challenge travels through the browser, the verifier does not.
		const verifier = codeVerifier();
		const url = await authorizationUrl(BASIC, {
			state: 's',
			redirectUri: REDIRECT,
			scopes: [],
			verifier
		});

		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).not.toBeNull();
		expect(url.toString()).not.toContain(verifier);
	});

	it('sends no challenge for a provider that does not use one', async () => {
		const url = await authorizationUrl(BASIC, { state: 's', redirectUri: REDIRECT, scopes: [] });

		expect(url.searchParams.has('code_challenge')).toBe(false);
	});

	it('carries a provider own parameters', async () => {
		// Google needs `access_type=offline` or it never issues a refresh token, which stays invisible
		// until a link lapses and cannot be renewed.
		const url = await authorizationUrl(BASIC, {
			state: 's',
			redirectUri: REDIRECT,
			scopes: [],
			extra: { access_type: 'offline', prompt: 'consent' }
		});

		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('prompt')).toBe('consent');
	});

	it('will not let a provider overwrite the protocol parameters', async () => {
		// The one that matters. An `extra` that could replace `state` would be a way to switch off the
		// check that binds a callback to this browser, and one that could replace `redirect_uri` would
		// point the code somewhere else.
		const url = await authorizationUrl(BASIC, {
			state: 'the-real-state',
			redirectUri: REDIRECT,
			scopes: ['a'],
			verifier: codeVerifier(),
			extra: {
				state: 'injected',
				client_id: 'injected',
				redirect_uri: 'https://evil.invalid/cb',
				response_type: 'token',
				code_challenge: 'injected',
				code_challenge_method: 'plain',
				scope: 'injected'
			}
		});

		expect(url.searchParams.get('state')).toBe('the-real-state');
		expect(url.searchParams.get('client_id')).toBe('a-client-id');
		expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).not.toBe('injected');
		expect(url.searchParams.get('scope')).toBe('a');
	});

	it('generates a different state every time', () => {
		expect(new Set(Array.from({ length: 50 }, () => oauthState())).size).toBe(50);
	});
});

describe('exchanging a code', () => {
	it('returns the tokens in this project terms', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));

		try {
			reply = () =>
				json({
					access_token: 'an-access-token',
					refresh_token: 'a-refresh-token',
					token_type: 'bearer',
					expires_in: 3600,
					scope: 'read write'
				});

			expect(await exchangeCode(BASIC, callback())).toStrictEqual({
				accessToken: 'an-access-token',
				refreshToken: 'a-refresh-token',
				expiresAt: Math.floor(Date.parse('2026-10-08T01:00:00.000Z') / 1000),
				scopes: ['read', 'write']
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('sends the code, the grant type and the redirect it was given', async () => {
		await exchangeCode(BASIC, callback());

		const body = new URLSearchParams(calls[0]?.body ?? '');

		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('the-code');
		expect(body.get('redirect_uri')).toBe(REDIRECT);
	});

	it('authenticates with HTTP Basic where the provider wants that', async () => {
		// Discord. In the header and not the body — sending the wrong one is a 401 that reads like a
		// bad client id.
		//
		// The credentials are **form-urlencoded before base64**, which is what RFC 6749 Appendix B
		// requires: it limits the unreserved set to letters and digits, so `-` becomes `%2D`. This is a
		// real change from `arctic`, which base64'd the raw strings. A conforming token endpoint decodes
		// before comparing and sees the same credentials either way; the encoding is asserted here
		// rather than normalised away so that a provider found to disagree is a known, located
		// difference instead of a mysterious 401.
		await exchangeCode(BASIC, callback());

		const encoded = Buffer.from('a%2Dclient%2Did:a%2Dclient%2Dsecret').toString('base64');

		expect(calls[0]?.authorization).toBe(`Basic ${encoded}`);
		expect(calls[0]?.body).not.toContain('client_secret');
	});

	it('puts the secret in the body where the provider wants that instead', async () => {
		// The other half, which is why this is per provider.
		await exchangeCode(TWITCHLIKE, callback());

		expect(calls[0]?.authorization).toBeNull();
		expect(new URLSearchParams(calls[0]?.body ?? '').get('client_secret')).toBe('a-client-secret');
	});

	it('sends a body credential exactly as it was given, punctuation and all', async () => {
		// The regression this exists for. Real client secrets are drawn from alphabets that include
		// `-` and `_`, and RFC 6749 Appendix B narrows the unreserved set to letters and digits — so an
		// encoding step that is correct for Basic mangles the secret for a provider that compares the
		// raw value. Discord documents Basic as plain base64 and says nothing about decoding, which is
		// why it uses the body; this asserts the body really is lossless.
		const awkward = 'sec-ret_with.punctuation~and-more';

		await exchangeCode({ ...TWITCHLIKE, clientSecret: awkward }, callback());

		expect(new URLSearchParams(calls[0]?.body ?? '').get('client_secret')).toBe(awkward);
	});

	it('re-encodes a Basic credential, which is the spec and also the hazard', async () => {
		// Recorded rather than normalised away. A provider that does not form-urldecode its Basic
		// header will compare against this, not against the secret in its dashboard — so whoever picks
		// `basic` for the next platform needs this difference to be visible rather than discovered as
		// a 401.
		const awkward = 'sec-ret_with.punctuation~and-more';

		await exchangeCode({ ...BASIC, clientSecret: awkward }, callback());

		const sent = Buffer.from((calls[0]?.authorization ?? '').replace('Basic ', ''), 'base64')
			.toString()
			.split(':')[1];

		expect(sent).not.toBe(awkward);
		expect(decodeURIComponent(sent ?? '')).toBe(awkward);
	});

	it('reports a provider that said nothing about expiry as having no expiry', async () => {
		reply = () => json({ access_token: 'at', token_type: 'bearer' });

		const tokens = await exchangeCode(BASIC, callback());

		expect(tokens.expiresAt).toBeNull();
		expect(tokens.refreshToken).toBeNull();
		expect(tokens.scopes).toStrictEqual([]);
	});

	it('treats zero seconds as no expiry rather than as expired in 1970', async () => {
		// Twitch sends `expires_in: 0` for a token type it does not expire. Arithmetic on it would put
		// the expiry at the epoch and make every such link render as lapsed forever.
		reply = () => json({ access_token: 'at', token_type: 'bearer', expires_in: 0 });

		expect((await exchangeCode(BASIC, callback())).expiresAt).toBeNull();
	});
});

describe("Twitch's array-valued scope", () => {
	/** What Twitch actually answers: `scope` as a JSON array, against RFC 6749 §5.1. */
	function twitchReply(): Response {
		return json({
			access_token: 'an-access-token',
			refresh_token: 'a-refresh-token',
			token_type: 'bearer',
			expires_in: 14_124,
			scope: ['channel:read:subscriptions', 'user:read:chat']
		});
	}

	it('is accepted, and read as the scopes it names', async () => {
		// The property this quirk exists for. Without it the response is refused outright and linking a
		// Twitch account fails at the last step, after the creator has already approved it.
		reply = twitchReply;

		expect((await exchangeCode(TWITCHLIKE, callback())).scopes).toStrictEqual([
			'channel:read:subscriptions',
			'user:read:chat'
		]);
	});

	it('is refused for a provider that did not declare the quirk', async () => {
		// Proving the quirk is what does the work rather than something incidental — and that the
		// library really is strict, so declaring it for a provider that does not need it would be
		// noticed.
		reply = twitchReply;

		await expect(exchangeCode(BASIC, callback())).rejects.toBeInstanceOf(OAuth2Failure);
	});

	it('leaves a response that is not JSON alone', async () => {
		// The shim must not turn an HTML error page from a proxy into something that parses, because
		// then the real failure is the one that goes missing.
		reply = () => new Response('<html>502</html>', { status: 502 });

		await expect(exchangeCode(TWITCHLIKE, callback())).rejects.toBeInstanceOf(OAuth2Failure);
	});

	it('leaves an already-correct string scope alone', async () => {
		reply = () => json({ access_token: 'at', token_type: 'bearer', scope: 'already a string' });

		expect((await exchangeCode(TWITCHLIKE, callback())).scopes).toStrictEqual([
			'already',
			'a',
			'string'
		]);
	});
});

describe('a flow that does not finish', () => {
	it('refuses a callback whose state is not the one in the cookie', async () => {
		// The flow compares these too, and that comparison is the one that binds the response to this
		// browser. This is the second check, and it must not be the one that is missing.
		await expect(exchangeCode(BASIC, callback({ state: 'somebody-elses' }))).rejects.toBeInstanceOf(
			OAuth2Failure
		);

		expect(calls).toStrictEqual([]);
	});

	it('refuses a declined authorization without asking for a token', async () => {
		// `error=access_denied` and no code: the visitor pressed cancel. Presenting that to the token
		// endpoint would turn a cancellation into a provider error.
		const declined: Callback = {
			params: new URLSearchParams({ error: 'access_denied', state: 'the-state' }),
			expectedState: 'the-state',
			verifier: null,
			redirectUri: REDIRECT
		};

		const failure = await exchangeCode(BASIC, declined).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(OAuth2Failure);
		expect((failure as OAuth2Failure).kind).toBe('refused');
		expect((failure as OAuth2Failure).code).toBe('access_denied');
		expect(calls).toStrictEqual([]);
	});

	it('tells a refusal apart from an unreachable provider', async () => {
		// They need different words for the visitor: one is "start again", the other is "try later".
		reply = () => json({ error: 'invalid_grant' }, 400);

		const refused = await exchangeCode(BASIC, callback()).catch((cause: unknown) => cause);

		expect((refused as OAuth2Failure).kind).toBe('refused');
		expect((refused as OAuth2Failure).code).toBe('invalid_grant');

		vi.stubGlobal('fetch', () => Promise.reject(new Error('the network is down')));

		const unreachable = await exchangeCode(BASIC, callback()).catch((cause: unknown) => cause);

		expect((unreachable as OAuth2Failure).kind).toBe('unreachable');
	});

	it.each([
		[
			'a refusal with a description',
			(): Response =>
				json({ error: 'invalid_grant', error_description: 'secret a-client-secret leaked' }, 400)
		],
		[
			'a gateway echoing the request',
			(): Response =>
				json({ error: 'bad', body: 'client_secret=a-client-secret&code=the-code' }, 500)
		]
	])('never repeats the secret or the code: %s', async (_name, answer) => {
		// The one that matters. A token request carries the client secret, and a rejection from an API
		// gateway can quote the request that produced it.
		reply = answer;

		const failure = await exchangeCode(BASIC, callback()).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(Error);

		const text = `${(failure as Error).name} ${(failure as Error).message}`;

		expect(text).not.toContain('a-client-secret');
		expect(text).not.toContain('the-code');
	});
});
