/**
 * Linking a YouTube channel.
 *
 * Three things here are YouTube's and not shared, and each is a bug if it regresses: the
 * authorization request has to ask for a refresh token or there will never be one, the identity is
 * a *channel* rather than a Google account, and a Google account with no channel has to be told so
 * rather than failing obscurely.
 *
 * The environment is mocked rather than read, as everywhere in this directory: a test that read the
 * project's own `.env` would pass on one machine and put a live client id in an assertion.
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
	get YOUTUBE_CLIENT_ID() {
		return env.id;
	},
	get YOUTUBE_CLIENT_SECRET() {
		return env.secret;
	}
}));

const { youtubeSignIn } = await import('./youtube-sign-in.js');
const { SignInFailure } = await import('./sign-in-provider.js');

import type { Grant } from './sign-in-provider.js';

const REDIRECT = 'https://site.example/auth/youtube/callback';

/** A valid channel id: `UC` and 22 more. */
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

/** What the stubbed endpoints answer. */
let tokenBody: unknown;
let channelsBody: unknown;
let channelsStatus: number;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** A `channels?mine=true` body. */
function channels(snippet: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		items: [
			{
				id: CHANNEL,
				snippet: {
					title: 'Someone’s Channel',
					customUrl: '@someone',
					thumbnails: {
						default: { url: 'https://yt3.googleusercontent.com/small.jpg' },
						medium: { url: 'https://yt3.googleusercontent.com/medium.jpg' }
					},
					...snippet
				}
			}
		]
	};
}

/**
 * A whole link, as `flow.ts` performs one: authorize for the verifier, then exchange.
 *
 * `grant` is called on its object rather than plucked into a local, because a detached method loses
 * its `this` — which happens to work for these providers and would break for one written otherwise.
 */
async function linked(): Promise<Grant> {
	const provider = youtubeSignIn();
	const { verifier } = await provider.authorize('the-state', REDIRECT);

	const grant = await provider.grant?.({
		params: new URLSearchParams({ code: 'the-code', state: 'the-state' }),
		expectedState: 'the-state',
		verifier,
		redirectUri: REDIRECT
	});

	// A platform whose link is worth keeping has to implement it, and this file's whole subject is
	// the credential that comes back.
	if (grant === undefined) throw new Error('youtube must implement grant');

	return grant;
}

beforeEach(() => {
	env.id = 'our-client-id';
	env.secret = 'our-client-secret';

	tokenBody = {
		access_token: 'an-access-token',
		refresh_token: 'a-refresh-token',
		token_type: 'bearer',
		expires_in: 3599,
		scope: 'https://www.googleapis.com/auth/youtube.readonly'
	};
	channelsBody = channels();
	channelsStatus = 200;

	vi.stubGlobal('fetch', (input: string | URL) => {
		const url = String(input);

		if (url.includes('oauth2.googleapis.com/token')) return Promise.resolve(json(tokenBody));
		if (url.includes('youtube/v3/channels')) {
			return Promise.resolve(json(channelsBody, channelsStatus));
		}

		return Promise.reject(new Error(`nothing stubbed for ${url}`));
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('starting a link', () => {
	it('asks for a refresh token, or there would never be one', async () => {
		// The property this exists for. Google issues a refresh token only when the authorization
		// request asks, and without one the link stops working an hour later with nothing to say so —
		// exactly the failure `auth/token.ts` exists to prevent.
		const { url } = await youtubeSignIn().authorize('s', REDIRECT);

		expect(url.searchParams.get('access_type')).toBe('offline');
	});

	it('uses PKCE, which Google advertises support for', async () => {
		const { url, verifier } = await youtubeSignIn().authorize('s', REDIRECT);

		expect(verifier).not.toBeNull();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.toString()).not.toContain(verifier);
	});

	it('points at Google and asks only to read YouTube', async () => {
		// Not `youtube` (which can delete videos), not `youtube.force-ssl` (which can comment as the
		// creator), and nothing from the rest of Google.
		const { url } = await youtubeSignIn().authorize('s', REDIRECT);

		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
	});

	it('refuses to build a URL when nothing is configured', async () => {
		env.id = undefined;

		await expect(youtubeSignIn().authorize('s', REDIRECT)).rejects.toBeInstanceOf(SignInFailure);
	});
});

describe('a channel that links', () => {
	it('is identified by its channel id, not by a Google account', async () => {
		// A Google `sub` is an opaque number this site could do nothing with. A channel id produces a
		// public URL worth putting on a page, and matches the `youtube` key in the platform registry.
		const grant = await linked();

		expect(grant.identity.provider).toBe('youtube');
		expect(grant.identity.providerUserId).toBe(CHANNEL);
	});

	it('prefers the handle over the title, because that is what a viewer recognises', async () => {
		expect((await linked()).identity.name).toBe('@someone');
	});

	it('falls back to the title when there is no handle', async () => {
		channelsBody = channels({ customUrl: null });

		expect((await linked()).identity.name).toBe('Someone’s Channel');
	});

	it('prefers the larger avatar', async () => {
		expect((await linked()).identity.avatarUrl).toBe(
			'https://yt3.googleusercontent.com/medium.jpg'
		);
	});

	it('falls back to the small avatar', async () => {
		channelsBody = channels({
			thumbnails: { default: { url: 'https://yt3.googleusercontent.com/small.jpg' } }
		});

		expect((await linked()).identity.avatarUrl).toBe('https://yt3.googleusercontent.com/small.jpg');
	});

	it('drops an avatar that is not https', async () => {
		channelsBody = channels({ thumbnails: { medium: { url: 'http://elsewhere.invalid/a.jpg' } } });

		expect((await linked()).identity).not.toHaveProperty('avatarUrl');
	});

	it('keeps the refresh token, so the link can be renewed', async () => {
		const grant = await linked();

		expect(grant.refreshToken).toBe('a-refresh-token');
		expect(grant.expiresAt).not.toBeNull();
	});
});

describe('a Google account that cannot be linked', () => {
	it('says it has no channel, rather than failing obscurely', async () => {
		// Google answers an empty `items` for an account with no channel — not an error. It is the one
		// honest limitation of keying this platform on a channel, so it gets a sentence a person can
		// act on.
		channelsBody = { items: [] };

		await expect(linked()).rejects.toThrow(/no YouTube channel/);
	});

	it('refuses a channel id that is not one', async () => {
		// It becomes a database key and is compared against rows.
		channelsBody = channels();
		channelsBody = { items: [{ id: '../../etc/passwd', snippet: {} }] };

		await expect(linked()).rejects.toBeInstanceOf(SignInFailure);
	});

	it('refuses when the channel request fails', async () => {
		// Unlike Twitch's `helix/users`, this is not decoration over an id already known: the token
		// exchange says nothing about who this is, so there is nothing to fall back to.
		channelsStatus = 500;

		await expect(linked()).rejects.toBeInstanceOf(SignInFailure);
	});
});

describe('what a failure message may contain', () => {
	it('never repeats the token or the credentials', async () => {
		channelsStatus = 500;
		channelsBody = { error: { message: 'an-access-token our-client-secret' } };

		const failure = await linked().catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain('an-access-token');
		expect((failure as Error).message).not.toContain('our-client-id');
		expect((failure as Error).message).not.toContain('our-client-secret');
	});
});
