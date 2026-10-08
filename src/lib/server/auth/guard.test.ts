/**
 * That a role check says no when it should, and says no the right way.
 *
 * The role ordering is the kind of thing that passes a glance and is off by one: `ROLES` is widest
 * first, so "at least an editor" is a *lower* index, and getting the comparison backwards would let
 * every member into the admin while locking the owner out. So every pair is asserted rather than a
 * representative few.
 */

import { describe, expect, it } from 'vitest';
import {
	atLeast,
	requireApi,
	requireRole,
	requireRoleForApi,
	requireSignIn,
	SIGN_IN_PATH
} from './guard.js';
import { ROLES } from '../db/schema.js';
import type { Ability, Role } from '../db/schema.js';
import type { Credential } from './guard.js';
import type { Principal } from '../session.js';

/** Somebody holding a role, with nothing else about them that matters here. */
function principal(role: Role): Principal {
	return { userId: 'u', name: 'Someone', avatarUrl: null, role };
}

/**
 * Somebody signed in through a browser.
 *
 * Every guard now wants a credential as well as a principal, and this is the ordinary one. Spelled
 * out as a helper rather than inlined so that the cases below which pass a *token* credential stand
 * out as the unusual ones they are.
 */
function session(role: Role): { principal: Principal; credential: Credential } {
	return { principal: principal(role), credential: { kind: 'session' } };
}

/** Somebody's program, holding a token with the given ability. */
function token(role: Role, ability: Ability): { principal: Principal; credential: Credential } {
	return { principal: principal(role), credential: { kind: 'token', id: 'row-id', ability } };
}

/** The page a guard is protecting. */
const PAGE = new URL('https://site.example/admin/links?tab=social');

/**
 * What SvelteKit's `redirect` and `error` throw, as the shape a test can read.
 *
 * Both are thrown objects rather than `Error`s, and the two carry different fields — a redirect has
 * a `location`, an error has a `body`. Narrowed here so each test can assert on one field without
 * repeating the cast.
 */
interface Thrown {
	readonly status?: number;
	readonly location?: string;
	readonly body?: { readonly message?: string };
}

function thrownBy(run: () => unknown): Thrown {
	try {
		run();
	} catch (cause) {
		return cause as Thrown;
	}

	throw new Error('nothing was thrown');
}

describe('atLeast', () => {
	it('is true for the same role', () => {
		for (const role of ROLES) expect(atLeast(role, role)).toBe(true);
	});

	it.each([...ROLES].flatMap((held) => ROLES.map((needed) => [held, needed] as const)))(
		'%s against %s matches the declared ordering',
		(held, needed) => {
			// `ROLES` is widest first, so holding a role at a lower index is holding more.
			expect(atLeast(held, needed)).toBe(ROLES.indexOf(held) <= ROLES.indexOf(needed));
		}
	);

	it('lets the owner everywhere', () => {
		for (const role of ROLES) expect(atLeast('owner', role)).toBe(true);
	});

	it('lets a member nowhere but to a member page', () => {
		expect(atLeast('member', 'moderator')).toBe(false);
		expect(atLeast('member', 'member')).toBe(true);
	});

	it('refuses a role that does not exist rather than treating it as the widest', () => {
		expect(atLeast('nonsense' as Role, 'member')).toBe(false);
	});

	it('refuses a requirement that does not exist', () => {
		// Fails closed in both directions: a typo in a route's requirement should lock the route, not
		// open it.
		expect(atLeast('owner', 'nonsense' as Role)).toBe(false);
	});
});

describe('requireSignIn', () => {
	it('hands back the principal when there is one', () => {
		expect(requireSignIn(session('member'), PAGE).role).toBe('member');
	});

	it('redirects a visitor with no session', () => {
		const thrown = thrownBy(() => requireSignIn({ principal: null }, PAGE));

		expect(thrown.status).toBe(303);
	});

	it('carries where they were going, path and query', () => {
		// Somebody who follows a link deep into the admin should land there, not on a dashboard having
		// forgotten what they came for.
		const thrown = thrownBy(() => requireSignIn({ principal: null }, PAGE));
		const location = thrown.location ?? '';

		expect(location.startsWith(`${SIGN_IN_PATH}?next=`)).toBe(true);
		expect(new URL(location, 'https://site.example').searchParams.get('next')).toBe(
			'/admin/links?tab=social'
		);
	});

	it('sends nothing but the path, so the sign-in page cannot be aimed off-site', () => {
		const thrown = thrownBy(() =>
			requireSignIn({ principal: null }, new URL('https://site.example/admin'))
		);

		expect(thrown.location).toBe(`${SIGN_IN_PATH}?next=%2Fadmin`);
	});
});

describe('requireRole', () => {
	it('hands back a principal who holds enough', () => {
		expect(requireRole(session('admin'), PAGE, 'editor').role).toBe('admin');
	});

	it('redirects somebody who is not signed in', () => {
		expect(thrownBy(() => requireRole({ principal: null }, PAGE, 'editor')).status).toBe(303);
	});

	it('refuses somebody signed in without the role', () => {
		// 403 rather than a redirect to sign in: they are signed in, so sending them to sign in again
		// is a loop.
		const thrown = thrownBy(() => requireRole(session('member'), PAGE, 'editor'));

		expect(thrown.status).toBe(403);
	});
});

describe('requireRoleForApi', () => {
	it('hands back a principal who holds enough', () => {
		expect(requireRoleForApi(session('owner'), 'admin').role).toBe('owner');
	});

	it('answers 401 for no session, so a client knows to sign in', () => {
		expect(thrownBy(() => requireRoleForApi({ principal: null }, 'editor')).status).toBe(401);
	});

	it('answers 403 for the wrong role, so a client knows not to bother', () => {
		expect(thrownBy(() => requireRoleForApi(session('member'), 'editor')).status).toBe(403);
	});

	it('never redirects, because a JSON client cannot follow one usefully', () => {
		// A machine handed a 302 to an HTML page reports a parse error, and the creator debugging their
		// own site reads the wrong thing.
		for (const locals of [{ principal: null }, session('member')]) {
			expect(thrownBy(() => requireRoleForApi(locals, 'editor')).location).toBeUndefined();
		}
	});

	it('asks only for the ability to read, so a read-only token works', () => {
		expect(requireRoleForApi(token('admin', 'read'), 'admin').role).toBe('admin');
	});
});

describe('requireApi, on the ability as well as the role', () => {
	it('lets a write token write', () => {
		expect(
			requireApi(token('admin', 'write'), { role: 'admin', ability: 'write' }).principal.role
		).toBe('admin');
	});

	it('lets a read token read', () => {
		expect(
			requireApi(token('admin', 'read'), { role: 'admin', ability: 'read' }).credential.kind
		).toBe('token');
	});

	it('refuses a read token on something that writes, however wide the role', () => {
		// The entire point of issuing a read-only token. An owner's token holds the widest role in
		// the installation and still cannot change anything, which is what makes it safe to paste
		// into somebody else's monitoring tool.
		expect(
			thrownBy(() => requireApi(token('owner', 'read'), { role: 'member', ability: 'write' }))
				.status
		).toBe(403);
	});

	it('says which of the two checks refused it', () => {
		// A 403 that does not distinguish "your role" from "your token" sends somebody to audit
		// their own account for an hour over a credential they could have reissued in a minute.
		expect(
			thrownBy(() => requireApi(token('owner', 'read'), { role: 'owner', ability: 'write' })).body
				?.message
		).toMatch(/token may only read/);
	});

	it('does not apply an ability ceiling to a session', () => {
		// A browser session has no ability: the person *is* their role. Asserted because the
		// alternative shape — a nominal ability on a session — would eventually be defaulted to
		// `read` by somebody tidying up, and that would break every form action in the admin.
		expect(requireApi(session('admin'), { role: 'admin', ability: 'write' }).credential.kind).toBe(
			'session'
		);
	});

	it('refuses a token whose holder lacks the role, before the ability is reached', () => {
		expect(
			thrownBy(() => requireApi(token('member', 'write'), { role: 'admin', ability: 'write' }))
				.status
		).toBe(403);
	});

	it('refuses a principal with no credential, rather than assuming a session', () => {
		// Impossible through `hooks.server.ts`, which sets both or neither. Refused anyway: the
		// assumption that would let it through — "it must be a browser" — grants strictly more than
		// a token would, and this function is the only place that decides.
		expect(
			thrownBy(() =>
				requireApi({ principal: principal('owner') }, { role: 'owner', ability: 'write' })
			).status
		).toBe(401);
	});
});

describe('an API token presented to a page', () => {
	it('is refused rather than redirected, because it is not a browser', () => {
		// Sending a script to an HTML sign-in page reports itself as a parse error a long way from
		// the cause.
		const thrown = thrownBy(() => requireSignIn(token('owner', 'write'), PAGE));

		expect(thrown.status).toBe(403);
		expect(thrown.location).toBeUndefined();
	});

	it('says where the token should be used instead', () => {
		expect(thrownBy(() => requireSignIn(token('owner', 'write'), PAGE)).body?.message).toMatch(
			/\/api/
		);
	});

	it('cannot reach a form action, which is what this is really protecting', () => {
		// Every form action in the admin calls `requireSignIn` or `requireRole`, and none was
		// written with a non-browser caller in mind. Keeping the two surfaces disjoint is what stops
		// a new action quietly becoming a token-reachable write with no ability check.
		expect(thrownBy(() => requireRole(token('owner', 'write'), PAGE, 'member')).status).toBe(403);
	});
});

describe('a guard called with no principal field at all', () => {
	// `hooks.server.ts` always sets it, so this only matters when something new calls a guard with a
	// hand-built object. The direction to fail in is "not signed in" — the alternative is an
	// `undefined` principal that every later optional chain quietly tolerates.
	it('redirects rather than handing back undefined', () => {
		expect(thrownBy(() => requireSignIn({}, PAGE)).status).toBe(303);
	});

	it('redirects from requireRole', () => {
		expect(thrownBy(() => requireRole({}, PAGE, 'member')).status).toBe(303);
	});

	it('answers 401 from the API guard', () => {
		expect(thrownBy(() => requireRoleForApi({}, 'member')).status).toBe(401);
	});
});
