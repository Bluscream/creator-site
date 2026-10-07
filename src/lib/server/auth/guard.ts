/**
 * Who is signed in, and whether they may do a thing.
 *
 * ### Resolved once per request, in `hooks.server.ts`
 *
 * The session is read in one place and put on `event.locals`, rather than each page asking. A page
 * that asks is a page that can forget to, and "forgot to check" is the failure mode that matters
 * here. It also means one database read per request instead of one per load function.
 *
 * ### Roles are an ordering, for now
 *
 * {@link ROLES} is widest first, so "at least an editor" is an index comparison. That is deliberately
 * simpler than the capability set the plan eventually calls for — a plugin declaring its own
 * capabilities needs a real grant model — and {@link atLeast} is the single place that would change.
 * A role check scattered across twenty load functions could not be changed at all.
 *
 * ### Failing is a redirect for a page and a 403 for an API
 *
 * A person who is not signed in should be sent to sign in, with where they were going attached. A
 * machine should be told no. {@link requireRole} does the first and {@link forbid} the second,
 * because a JSON client handed a 302 to an HTML page reports a parse error and a creator debugging
 * their own site reads the wrong thing.
 */

import { error, redirect } from '@sveltejs/kit';
import { ROLES } from '../db/schema.js';
import type { Role } from '../db/schema.js';
import type { Principal } from '../session.js';

/**
 * What a guard needs from `event.locals`.
 *
 * Optional as well as nullable, so a caller that forgot to resolve the session is refused rather
 * than handed an `undefined` principal that every later `?.` quietly tolerates.
 */
interface Signed {
	readonly principal?: Principal | null;
}

/** Where an unauthenticated visitor is sent. */
export const SIGN_IN_PATH = '/auth/sign-in';

/**
 * Whether a role is at least as wide as another.
 *
 * {@link ROLES} is ordered widest first, so a *lower* index is more. An unknown role — which
 * `roleOf` should have prevented — is treated as insufficient rather than as the widest.
 */
export function atLeast(held: Role, needed: Role): boolean {
	const have = ROLES.indexOf(held);
	const want = ROLES.indexOf(needed);

	return have !== -1 && want !== -1 && have <= want;
}

/**
 * The signed-in principal, or a redirect to sign in.
 *
 * `next` carries where they were going, so somebody who follows a link to a page deep in the admin
 * lands there rather than on a dashboard, having forgotten what they came for.
 */
export function requireSignIn(locals: Signed, url: URL): Principal {
	const { principal } = locals;

	// `!= null` in spirit: an absent `principal` has to be refused as well as an explicitly null one.
	// `hooks.server.ts` always sets it, so this only matters when something new calls a guard with a
	// hand-built object — and the direction to fail in is "not signed in".
	if (principal !== null && principal !== undefined) return principal;

	redirect(303, `${SIGN_IN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`);
}

/**
 * The signed-in principal, if they hold at least `needed`.
 *
 * A signed-in visitor without the role gets 403 rather than a redirect to sign in: they are signed
 * in, so sending them to sign in again is a loop, and the honest answer is that this is not theirs
 * to see.
 */
export function requireRole(locals: Signed, url: URL, needed: Role): Principal {
	const principal = requireSignIn(locals, url);

	if (!atLeast(principal.role, needed)) {
		error(403, 'That part of the site is not yours to see.');
	}

	return principal;
}

/**
 * The same check for an API route: throws a status rather than redirecting.
 *
 * 401 for "sign in" and 403 for "not you", which is the distinction a client can act on — the first
 * means try again with a session, the second means do not bother.
 */
export function requireRoleForApi(locals: Signed, needed: Role): Principal {
	const { principal } = locals;

	if (principal === null || principal === undefined) error(401, 'Not signed in.');
	if (!atLeast(principal.role, needed)) error(403, 'Not allowed.');

	return principal;
}

/** Shorthand used where a route has nothing but a role requirement. */
export function forbid(): never {
	error(403, 'Not allowed.');
}
