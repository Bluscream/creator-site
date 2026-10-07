/**
 * The provider-independent half of signing in: the `state` check, the redirect allow-list, and the
 * cookies.
 *
 * These are the parts where a mistake is a vulnerability rather than a bug, and they are tested
 * against a stand-in provider rather than Discord — the point of the seam is that none of this
 * depends on which vendor is behind it, and a test that needed a real OAuth server would not be run.
 *
 * The account store underneath is real, against an in-memory SQLite, so "signing in twice finds the
 * same user" and "the first account owns the install" are exercised through the flow as well as in
 * `../accounts.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../fixtures/memory-db.js';
import type { OpenMemoryDb } from '../fixtures/memory-db.js';
import type { ProviderIdentity } from '../accounts.js';
import type { Authorization, SignInProvider } from './sign-in-provider.js';
import type { CookieJar, FlowRequest } from './flow.js';

const open = vi.hoisted(() => ({ current: null as { db: unknown } | null }));

vi.mock('../db/index.js', () => ({
	db: () => {
		if (open.current === null) throw new Error('no test database is open');

		return open.current.db;
	},
	closeDb: () => undefined
}));

vi.mock('../log.js', () => ({
	log: () => ({
		error: () => undefined,
		warn: () => undefined,
		info: () => undefined,
		debug: () => undefined
	})
}));

/** The environment the flow reads. Mocked so a developer's own `.env` cannot change a result. */
const env = vi.hoisted(() => ({ redirect: undefined as string | undefined }));

vi.mock('$app/env/private', () => ({
	get DISCORD_REDIRECT_URI() {
		return env.redirect;
	},
	ADMIN_ACCOUNTS: [] as string[],
	ALLOW_REGISTRATION: true
}));

const {
	DEFAULT_DESTINATION,
	PENDING_COOKIE,
	beginSignIn,
	completeSignIn,
	redirectUriFor,
	safePath,
	signOut
} = await import('./flow.js');

const { SignInFailure } = await import('./sign-in-provider.js');
const { SESSION_COOKIE, resolve } = await import('../session.js');
const { findByIdentity, identitiesOf, signIn } = await import('../accounts.js');

let database: OpenMemoryDb;

beforeEach(() => {
	database = memoryDb();
	open.current = { db: database.db };
	env.redirect = undefined;
});

afterEach(() => {
	open.current = null;
	database.close();
});

/** A cookie jar with the parts of SvelteKit's `Cookies` this module uses. */
function jar(initial: Readonly<Record<string, string>> = {}) {
	const values = new Map(Object.entries(initial));

	const cookies: CookieJar = {
		get: (name) => values.get(name),
		set: (name, value) => {
			values.set(name, value);
		},
		delete: (name) => {
			values.delete(name);
		}
	};

	return { cookies, values };
}

/** One recorded `set`, so a test can assert on the flags rather than only the value. */
interface RecordedSet {
	readonly name: string;
	readonly value: string;
	/** The flags the cookie was set with, as SvelteKit's own options type. */
	readonly options: Parameters<CookieJar['set']>[2];
}

/** A jar that remembers how each cookie was set. */
function recordingJar(): { readonly sets: readonly RecordedSet[]; readonly cookies: CookieJar } {
	const sets: RecordedSet[] = [];
	const values = new Map<string, string>();

	return {
		sets,
		cookies: {
			get: (name) => values.get(name),
			set: (name, value, options) => {
				values.set(name, value);
				sets.push({ name, value, options });
			},
			delete: (name) => {
				values.delete(name);
			}
		}
	};
}

/** A provider that does what a provider does and nothing else. */
function stubProvider(overrides: Partial<SignInProvider> = {}): SignInProvider {
	return {
		kind: 'stub',
		label: 'Stub',
		usable: () => true,
		authorize: (state, redirectUri): Authorization => ({
			url: new URL(`https://provider.example/authorize?state=${state}&redirect=${redirectUri}`),
			verifier: null
		}),
		identify: () =>
			Promise.resolve<ProviderIdentity>({
				provider: 'stub',
				providerUserId: '1',
				name: 'Someone'
			}),
		...overrides
	};
}

/** The event shape the flow takes: a URL and a cookie jar. */
function requestFor(url: string, cookies: CookieJar): FlowRequest {
	return { url: new URL(url, 'https://site.example'), cookies };
}

describe('safePath', () => {
	it.each([
		'/admin',
		'/admin/links',
		'/admin?tab=links',
		'/de/admin',
		'/admin#section',
		'/a/b/c.json'
	])('keeps %s', (path) => {
		expect(safePath(path)).toBe(path);
	});

	it.each([
		['an absolute url', 'https://evil.example/'],
		['a protocol-relative url', '//evil.example/'],
		['a backslash-relative url', '\\\\evil.example'],
		['a scheme with no host', 'javascript:alert(1)'],
		['a bare word', 'admin'],
		['the empty string', ''],
		['whitespace', '   '],
		['a newline injection', '/admin\nLocation: https://evil.example']
	])('refuses %s', (_, candidate) => {
		expect(safePath(candidate)).toBe(DEFAULT_DESTINATION);
	});

	it('refuses null and undefined', () => {
		expect(safePath(null)).toBe(DEFAULT_DESTINATION);
		expect(safePath(undefined)).toBe(DEFAULT_DESTINATION);
	});

	it('takes the fallback it was given rather than the admin', () => {
		// Signing out defaults to the public site: somebody who has just signed out should not be sent
		// to a page that signs them in.
		expect(safePath('https://evil.example', '/')).toBe('/');
	});

	it('trims surrounding whitespace rather than refusing over it', () => {
		expect(safePath('  /admin  ')).toBe('/admin');
	});
});

describe('redirectUriFor', () => {
	it('is derived from the request', () => {
		// The site answers on several hostnames and each registers its own redirect.
		expect(redirectUriFor('stub', new URL('https://site.example/auth/stub/login'))).toBe(
			'https://site.example/auth/stub/callback'
		);
	});

	it('keeps the request host rather than a configured one', () => {
		expect(redirectUriFor('stub', new URL('https://other.example/x'))).toBe(
			'https://other.example/auth/stub/callback'
		);
	});

	it('honours the pin for the provider it names', () => {
		env.redirect = 'https://pinned.example/auth/discord/callback';

		expect(redirectUriFor('discord', new URL('https://site.example/x'))).toBe(
			'https://pinned.example/auth/discord/callback'
		);
	});

	it('leaves other providers alone when one is pinned', () => {
		env.redirect = 'https://pinned.example/auth/discord/callback';

		expect(redirectUriFor('stub', new URL('https://site.example/x'))).toBe(
			'https://site.example/auth/stub/callback'
		);
	});
});

describe('beginSignIn', () => {
	it('sends the visitor to the provider', () => {
		const { cookies } = jar();

		const url = beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		expect(url.origin).toBe('https://provider.example');
	});

	it('remembers the flow in a cookie', () => {
		const { cookies, values } = jar();

		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		expect(values.has(PENDING_COOKIE)).toBe(true);
	});

	it('puts the state it generated in both the URL and the cookie', () => {
		const { cookies, values } = jar();

		const url = beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));
		const stored = JSON.parse(values.get(PENDING_COOKIE) ?? '{}') as { state?: string };

		expect(stored.state).toBe(url.searchParams.get('state'));
	});

	it('generates a different state each time', () => {
		const states = new Set(
			Array.from({ length: 20 }, () => {
				const { cookies } = jar();

				return beginSignIn(
					stubProvider(),
					requestFor('/auth/stub/login', cookies)
				).searchParams.get('state');
			})
		);

		expect(states.size).toBe(20);
	});

	it('remembers where the visitor was going', () => {
		const { cookies, values } = jar();

		beginSignIn(stubProvider(), requestFor('/auth/stub/login?next=%2Fadmin%2Flinks', cookies));

		expect(JSON.parse(values.get(PENDING_COOKIE) ?? '{}')).toMatchObject({
			next: '/admin/links'
		});
	});

	it('refuses an off-site destination at the point it is stored', () => {
		const { cookies, values } = jar();

		beginSignIn(
			stubProvider(),
			requestFor('/auth/stub/login?next=https%3A%2F%2Fevil.example', cookies)
		);

		expect(JSON.parse(values.get(PENDING_COOKIE) ?? '{}')).toMatchObject({
			next: DEFAULT_DESTINATION
		});
	});

	it('marks the pending cookie HttpOnly and Secure', () => {
		// It holds the only thing standing between a forged callback and a session.
		const { cookies, sets } = recordingJar();

		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		expect(sets[0]?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
	});
});

/** Runs a whole round trip and hands back the jar, so a test can assert on either half. */
async function roundTrip(
	provider: SignInProvider = stubProvider(),
	options: { readonly next?: string } = {}
) {
	const { cookies, values } = jar();
	const query = options.next === undefined ? '' : `?next=${encodeURIComponent(options.next)}`;

	const authorizeUrl = beginSignIn(provider, requestFor(`/auth/stub/login${query}`, cookies));
	const state = authorizeUrl.searchParams.get('state') ?? '';

	const completed = await completeSignIn(
		provider,
		requestFor(`/auth/stub/callback?code=abc&state=${encodeURIComponent(state)}`, cookies)
	);

	return { completed, cookies, values };
}

describe('completeSignIn', () => {
	it('signs the visitor in', async () => {
		const { completed } = await roundTrip();

		expect(completed.principal.name).toBe('Someone');
	});

	it('makes the first account the owner', async () => {
		const { completed } = await roundTrip();

		expect(completed.principal.role).toBe('owner');
	});

	it('issues a session cookie', async () => {
		const { values } = await roundTrip();

		expect(values.get(SESSION_COOKIE)).toBeDefined();
	});

	it('issues a session that resolves to the same person', async () => {
		const { completed, values } = await roundTrip();

		expect(resolve(values.get(SESSION_COOKIE) ?? '')?.principal.userId).toBe(
			completed.principal.userId
		);
	});

	it('marks the session cookie HttpOnly and Secure', async () => {
		const { cookies, sets } = recordingJar();

		const url = beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));
		const state = url.searchParams.get('state') ?? '';

		await completeSignIn(
			stubProvider(),
			requestFor(`/auth/stub/callback?code=abc&state=${state}`, cookies)
		);

		const session = sets.find((entry) => entry.name === SESSION_COOKIE);

		// `lax` rather than `strict`, because the callback is a top-level navigation from the provider
		// and `strict` would withhold the cookie on exactly that request.
		expect(session?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
	});

	it('returns where the visitor was going', async () => {
		const { completed } = await roundTrip(stubProvider(), { next: '/admin/links' });

		expect(completed.next).toBe('/admin/links');
	});

	it('clears the pending cookie', async () => {
		const { values } = await roundTrip();

		expect(values.has(PENDING_COOKIE)).toBe(false);
	});

	it('refuses a state that does not match the cookie', async () => {
		// The whole login-CSRF defence. A third party can make a browser issue the callback; they
		// cannot read or set this cookie.
		const { cookies } = jar();
		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		await expect(
			completeSignIn(
				stubProvider(),
				requestFor('/auth/stub/callback?code=abc&state=forged', cookies)
			)
		).rejects.toThrow(SignInFailure);
	});

	it('issues no session when the state does not match', async () => {
		const { cookies, values } = jar();
		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		await completeSignIn(
			stubProvider(),
			requestFor('/auth/stub/callback?code=abc&state=forged', cookies)
		).catch(() => null);

		expect(values.has(SESSION_COOKIE)).toBe(false);
	});

	it('refuses a callback for a different provider than the one that started it', async () => {
		const { cookies } = jar();
		const url = beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));
		const state = url.searchParams.get('state') ?? '';

		await expect(
			completeSignIn(
				stubProvider({ kind: 'other' }),
				requestFor(`/auth/other/callback?code=abc&state=${state}`, cookies)
			)
		).rejects.toThrow(SignInFailure);
	});

	it('refuses a callback with no pending flow at all', async () => {
		const { cookies } = jar();

		await expect(
			completeSignIn(stubProvider(), requestFor('/auth/stub/callback?code=a&state=b', cookies))
		).rejects.toThrow(/expired/);
	});

	it('refuses a pending cookie that is not JSON', async () => {
		const { cookies } = jar({ [PENDING_COOKIE]: 'not json' });

		await expect(
			completeSignIn(stubProvider(), requestFor('/auth/stub/callback?code=a&state=b', cookies))
		).rejects.toThrow(SignInFailure);
	});

	it('clears an unreadable pending cookie rather than leaving it to fail forever', async () => {
		const { cookies, values } = jar({ [PENDING_COOKIE]: 'not json' });

		await completeSignIn(
			stubProvider(),
			requestFor('/auth/stub/callback?code=a&state=b', cookies)
		).catch(() => null);

		expect(values.has(PENDING_COOKIE)).toBe(false);
	});

	it('re-checks the destination on the way out of the cookie', async () => {
		// The cookie came back from the visitor's browser. A check made before it was stored is not a
		// check that still holds.
		const { cookies } = jar({
			[PENDING_COOKIE]: JSON.stringify({
				kind: 'stub',
				state: 'abc',
				verifier: null,
				next: 'https://evil.example'
			})
		});

		const completed = await completeSignIn(
			stubProvider(),
			requestFor('/auth/stub/callback?code=a&state=abc', cookies)
		);

		expect(completed.next).toBe(DEFAULT_DESTINATION);
	});

	it('reports a declined prompt as a cancellation, not a failure', async () => {
		const { cookies } = jar();
		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies));

		await expect(
			completeSignIn(stubProvider(), requestFor('/auth/stub/callback?error=access_denied', cookies))
		).rejects.toThrow(/cancelled/);
	});

	it('clears the pending flow even when the provider throws', async () => {
		// A flow is single-use whatever happens to it, so a refresh of a failed callback says "start
		// again" rather than trying the same code twice.
		const { cookies, values } = jar();
		const provider = stubProvider({
			identify: () => Promise.reject(new SignInFailure('nope'))
		});
		const url = beginSignIn(provider, requestFor('/auth/stub/login', cookies));
		const state = url.searchParams.get('state') ?? '';

		await completeSignIn(
			provider,
			requestFor(`/auth/stub/callback?code=a&state=${state}`, cookies)
		).catch(() => null);

		expect(values.has(PENDING_COOKIE)).toBe(false);
	});

	it('finds the same account on a second round trip', async () => {
		const first = await roundTrip();
		const second = await roundTrip();

		expect(second.completed.principal.userId).toBe(first.completed.principal.userId);
	});

	it('leaves one user row after two round trips', async () => {
		await roundTrip();
		await roundTrip();

		expect(database.rows('SELECT id FROM users')).toHaveLength(1);
	});
});

describe('signOut', () => {
	it('clears the session cookie', async () => {
		const { values, cookies } = await roundTrip();

		signOut({ cookies });

		expect(values.has(SESSION_COOKIE)).toBe(false);
	});

	it('deletes the session row, not just the cookie', async () => {
		// Clearing the cookie alone would leave a usable credential in whatever read it — which is the
		// reason sessions are rows at all.
		const { values, cookies } = await roundTrip();
		const token = values.get(SESSION_COOKIE) ?? '';

		signOut({ cookies });

		expect(resolve(token)).toBeNull();
	});

	it('does nothing in particular when nobody is signed in', () => {
		const { cookies } = jar();

		expect(() => {
			signOut({ cookies });
		}).not.toThrow();
	});
});

/**
 * Linking another way to sign in.
 *
 * A different thing from signing in, and the difference is where the takeover risk is: the identity
 * that comes back is attached to an account that already exists. So every one of these is about a
 * way that could go wrong — the wrong account, nobody's account, or somebody else's identity.
 */
describe('the link intent', () => {
	/** Signs somebody in and hands back their principal and jar. */
	async function existing() {
		const { completed, cookies, values } = await roundTrip();

		return { principal: completed.principal, cookies, values };
	}

	/** Runs a link flow for `signedIn`, with `provider` answering as whatever identity it answers. */
	async function linkTrip(
		provider: SignInProvider,
		signedIn: Parameters<typeof completeSignIn>[2],
		options: { readonly startedBy?: string } = {}
	) {
		const { cookies } = jar();
		const url = beginSignIn(provider, requestFor('/auth/stub/login', cookies), {
			intent: 'link',
			...(options.startedBy === undefined ? {} : { userId: options.startedBy })
		});
		const state = url.searchParams.get('state') ?? '';

		return completeSignIn(
			provider,
			requestFor(`/auth/stub/callback?code=abc&state=${state}`, cookies),
			signedIn
		);
	}

	/** A provider answering as a different person from the one `stubProvider` answers as. */
	function otherIdentity(): SignInProvider {
		return stubProvider({
			kind: 'other',
			identify: () =>
				Promise.resolve<ProviderIdentity>({
					provider: 'other',
					providerUserId: '99',
					name: 'Another'
				})
		});
	}

	it('attaches the new identity to the signed-in account', async () => {
		const { principal } = await existing();

		await linkTrip(otherIdentity(), principal, { startedBy: principal.userId });

		expect(
			identitiesOf(principal.userId)
				.map((row) => row.provider)
				.toSorted()
		).toStrictEqual(['other', 'stub']);
	});

	it('reports that it was a link rather than a sign-in', async () => {
		const { principal } = await existing();

		const completed = await linkTrip(otherIdentity(), principal, { startedBy: principal.userId });

		expect(completed.intent).toBe('link');
	});

	it('creates no second account', async () => {
		const { principal } = await existing();

		await linkTrip(otherIdentity(), principal, { startedBy: principal.userId });

		expect(database.rows('SELECT id FROM users')).toHaveLength(1);
	});

	it('issues no second session, because they are already signed in', async () => {
		const { principal } = await existing();

		await linkTrip(otherIdentity(), principal, { startedBy: principal.userId });

		expect(database.rows('SELECT id FROM sessions')).toHaveLength(1);
	});

	it('makes the new identity resolve to the same account', async () => {
		const { principal } = await existing();

		await linkTrip(otherIdentity(), principal, { startedBy: principal.userId });

		expect(findByIdentity('other', '99')?.userId).toBe(principal.userId);
	});

	it('refuses a link with nobody signed in', async () => {
		await existing();

		await expect(linkTrip(otherIdentity(), null, { startedBy: 'somebody' })).rejects.toThrow(
			/signed in/
		);
	});

	it('refuses a flow started by a different account', async () => {
		// A shared browser where somebody signed out and back in while the first tab was away at the
		// provider. The alternative attaches one person's identity to whoever holds the session now.
		const { principal } = await existing();

		await expect(
			linkTrip(otherIdentity(), principal, { startedBy: 'somebody-else' })
		).rejects.toThrow(/different account/);
	});

	it('refuses a flow that named nobody', async () => {
		const { principal } = await existing();

		await expect(linkTrip(otherIdentity(), principal)).rejects.toThrow(/different account/);
	});

	it('attaches nothing when it refuses', async () => {
		const { principal } = await existing();

		await linkTrip(otherIdentity(), principal, { startedBy: 'somebody-else' }).catch(() => null);

		expect(findByIdentity('other', '99')).toBeNull();
	});

	it('refuses an identity another account already holds', async () => {
		// Refusing rather than reassigning: moving an identity between accounts is how one person takes
		// over another's.
		const { principal } = await existing();
		const other = signIn({ provider: 'other', providerUserId: '99' }, { register: true });

		if (!other.ok) throw new Error('could not create the other account');

		await expect(
			linkTrip(otherIdentity(), principal, { startedBy: principal.userId })
		).rejects.toThrow(/already in use/);

		expect(findByIdentity('other', '99')?.userId).toBe(other.principal.userId);
	});

	it('refuses an identity this same account already holds', async () => {
		const { principal } = await existing();

		await expect(
			linkTrip(stubProvider(), principal, { startedBy: principal.userId })
		).rejects.toThrow(/already in use/);
	});

	it('does not remember a user id for an ordinary sign-in', () => {
		// So a cookie from a sign-in cannot be replayed as a link.
		const { cookies, values } = jar();

		beginSignIn(stubProvider(), requestFor('/auth/stub/login', cookies), {
			intent: 'sign-in',
			userId: 'somebody'
		});

		expect(JSON.parse(values.get(PENDING_COOKIE) ?? '{}')).toMatchObject({ userId: null });
	});

	it('treats an unrecognised intent in a cookie as an ordinary sign-in', async () => {
		// Failing towards signing somebody in is safe; failing towards attaching an identity is not.
		const { cookies } = jar({
			[PENDING_COOKIE]: JSON.stringify({
				kind: 'stub',
				state: 'abc',
				verifier: null,
				next: '/admin',
				intent: 'something-else',
				userId: 'somebody'
			})
		});

		const completed = await completeSignIn(
			stubProvider(),
			requestFor('/auth/stub/callback?code=a&state=abc', cookies)
		);

		expect(completed.intent).toBe('sign-in');
	});
});
