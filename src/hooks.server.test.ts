/**
 * That a request's credential is resolved once, from the right place.
 *
 * Only `handleSession`, and only the part no other test can see: which of two credentials wins when
 * both are present, and that `principal` and `credential` are always set together. `guard.test.ts`
 * covers what the guards then do with them, and `api-tokens.test.ts` covers the resolution itself.
 *
 * The precedence claim is the reason this file exists. A read-only API token sent by somebody who is
 * also signed in to the admin in that browser must resolve as **the token**, not as their session —
 * otherwise the one person most likely to test that a read-only token cannot write is the one person
 * for whom it appears to be able to.
 */

import { describe, expect, it, vi } from 'vitest';
import type * as ApiTokens from '#lib/server/api-tokens.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { Principal } from '#lib/server/session.js';

const PRINCIPAL: Principal = {
	userId: 'someone',
	name: 'Someone',
	avatarUrl: null,
	role: 'owner'
};

const resolveSession = vi.hoisted(() => vi.fn<(token: string) => unknown>());
const resolveToken = vi.hoisted(() => vi.fn<(token: string) => unknown>());

vi.mock('#lib/server/session.js', () => ({
	SESSION_COOKIE: 'creator_session',
	resolve: resolveSession
}));

vi.mock('#lib/server/api-tokens.js', async () => {
	// The real header parser, because the point of moving it into that module was that it is tested
	// there — a second copy here would be a second thing to keep in step.
	const real = await vi.importActual<typeof ApiTokens>('#lib/server/api-tokens.js');

	return { tokenFromHeader: real.tokenFromHeader, resolve: resolveToken };
});

vi.mock('#lib/server/events.js', () => ({ startGateway: () => Promise.resolve() }));

const { handleSession } = await import('./hooks.server.js');

/** What the hook writes, after running it against a request built from the given pieces. */
async function run(options: { readonly cookie?: string; readonly authorization?: string }) {
	const headers = new Headers();

	if (options.authorization !== undefined) headers.set('authorization', options.authorization);

	const locals = {} as App.Locals;
	const set = vi.fn();

	const event = {
		request: new Request('https://site.example/api/metrics', { headers }),
		locals,
		cookies: { get: () => options.cookie, set }
	} as unknown as RequestEvent;

	await handleSession({ event, resolve: () => Promise.resolve(new Response('ok')) });

	return { locals, set };
}

describe('with neither credential', () => {
	it('leaves nobody signed in', async () => {
		const { locals } = await run({});

		expect(locals.principal).toBeNull();
	});

	it('sets the credential to null as well, not undefined', async () => {
		// The guards treat an absent credential as a refusal, so this is not cosmetic: a route that
		// read `credential` before this hook had set it would see `undefined` either way, and the
		// point is that the hook always writes both fields.
		const { locals } = await run({});

		expect(locals.credential).toBeNull();
	});
});

describe('with a session cookie', () => {
	it('signs them in', async () => {
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });

		const { locals } = await run({ cookie: 'a-session-token' });

		expect(locals.principal).toStrictEqual(PRINCIPAL);
	});

	it('records that it was a session', async () => {
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });

		const { locals } = await run({ cookie: 'a-session-token' });

		expect(locals.credential).toStrictEqual({ kind: 'session' });
	});

	it('refreshes the cookie, so its expiry matches the row that slid', async () => {
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });

		const { set } = await run({ cookie: 'a-session-token' });

		expect(set).toHaveBeenCalled();
	});
});

describe('with a bearer token', () => {
	it('signs them in as the token’s owner', async () => {
		resolveToken.mockReturnValue({ principal: PRINCIPAL, id: 'row', ability: 'read' });

		const { locals } = await run({ authorization: 'Bearer crs_something' });

		expect(locals.principal).toStrictEqual(PRINCIPAL);
	});

	it('carries the token’s ability and row id, which is what the guards need', async () => {
		resolveToken.mockReturnValue({ principal: PRINCIPAL, id: 'row', ability: 'read' });

		const { locals } = await run({ authorization: 'Bearer crs_something' });

		expect(locals.credential).toStrictEqual({ kind: 'token', id: 'row', ability: 'read' });
	});

	it('sets no cookie, because a token is not a browser session', async () => {
		resolveToken.mockReturnValue({ principal: PRINCIPAL, id: 'row', ability: 'write' });

		const { set } = await run({ authorization: 'Bearer crs_something' });

		expect(set).not.toHaveBeenCalled();
	});

	it('leaves nobody signed in for a token that does not resolve', async () => {
		resolveToken.mockReturnValue(null);

		const { locals } = await run({ authorization: 'Bearer crs_nope' });

		expect(locals.principal).toBeNull();
		expect(locals.credential).toBeNull();
	});
});

describe('with both, which is the case that matters', () => {
	it('honours the token rather than the cookie', async () => {
		// The explicit signal wins. Preferring the cookie would mean a read-only token appears to be
		// able to write — for exactly the person checking that it cannot, because they are the one
		// signed in to the admin in the browser they are testing from.
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });
		resolveToken.mockReturnValue({ principal: PRINCIPAL, id: 'row', ability: 'read' });

		const { locals } = await run({
			cookie: 'a-session-token',
			authorization: 'Bearer crs_something'
		});

		expect(locals.credential).toStrictEqual({ kind: 'token', id: 'row', ability: 'read' });
	});

	it('does not even look at the cookie', async () => {
		resolveSession.mockClear();
		resolveToken.mockReturnValue({ principal: PRINCIPAL, id: 'row', ability: 'read' });

		await run({ cookie: 'a-session-token', authorization: 'Bearer crs_something' });

		expect(resolveSession).not.toHaveBeenCalled();
	});

	it('refuses rather than falling back, when the token is bad but the cookie is good', async () => {
		// A deliberate choice, and the safer one: a client that attached a credential meant to use
		// it, and silently serving them as their cookie instead would hide a revoked token from the
		// script that is still presenting it.
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });
		resolveToken.mockReturnValue(null);

		const { locals } = await run({ cookie: 'a-session-token', authorization: 'Bearer crs_nope' });

		expect(locals.principal).toBeNull();
	});
});

describe('with an Authorization header that is not a bearer token', () => {
	it('falls through to the cookie, so a proxy’s own header breaks nothing', async () => {
		// Infrastructure that adds `Authorization` of its own would otherwise sign the creator out of
		// their own admin, two layers away from anything that mentions it.
		resolveSession.mockReturnValue({ principal: PRINCIPAL, expiresAt: 2_000_000_000 });

		const { locals } = await run({
			cookie: 'a-session-token',
			authorization: 'Basic YWRtaW46aHVudGVyMg=='
		});

		expect(locals.credential).toStrictEqual({ kind: 'session' });
	});
});
