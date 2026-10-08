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
 *
 * ### Two credentials, two surfaces
 *
 * A request arrives with a session cookie or an API token, and `hooks.server.ts` resolves either
 * into the same {@link Principal} plus a {@link Credential} saying which it was. The split that
 * follows is deliberate and narrow:
 *
 * | surface | credential | guard |
 * | --- | --- | --- |
 * | pages and their form actions | session only | {@link requireSignIn}, {@link requireRole} |
 * | `/api/…` | session or token | {@link requireApi}, {@link requireRoleForApi} |
 *
 * A token therefore cannot reach a form action, and an endpoint that writes has to ask for the
 * ability to. See {@link requireSignIn} and {@link requireApi} for why each half is drawn there.
 */

import { error, redirect } from '@sveltejs/kit';
import { ROLES } from '../db/schema.js';
import { permits } from '../api-tokens.js';
import type { Ability, Role } from '../db/schema.js';
import type { Principal } from '../session.js';

/**
 * How a request proved who it is.
 *
 * A discriminated union rather than a nullable `tokenId` on the principal, so the ability question
 * cannot be asked of a session: a browser session has no ability ceiling — the person *is* their
 * role — and giving it a nominal `'write'` would make an ability look like something a session has
 * too, which is the sort of field that later grows a bug.
 */
export type Credential =
	| { readonly kind: 'session' }
	| {
			readonly kind: 'token';

			/** The token's row id. For logging which credential acted, never the credential. */
			readonly id: string;
			readonly ability: Ability;
	  };

/**
 * What a guard needs from `event.locals`.
 *
 * Optional as well as nullable, so a caller that forgot to resolve the session is refused rather
 * than handed an `undefined` principal that every later `?.` quietly tolerates.
 */
interface Signed {
	readonly principal?: Principal | null;
	readonly credential?: Credential | null;
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
 *
 * ### A page needs a session, not a token
 *
 * An API token authenticates `/api/…` and nothing else. The reason is not that serving HTML to a
 * script would be harmful — it is that pages carry **form actions**, which are writes reached by a
 * `POST` to the page's own path, guarded by nothing but this function. Allowing a token here would
 * mean every existing action silently gained a second way in, with no ability check, because none of
 * them was written with a non-browser caller in mind. Keeping the two surfaces disjoint means a new
 * action cannot accidentally become a token-reachable write.
 */
export function requireSignIn(locals: Signed, url: URL): Principal {
	const { principal, credential } = locals;

	// 403 rather than the redirect below: a client holding a token is not a browser, and sending it
	// to an HTML sign-in page would report itself as a parse error somewhere far from the cause.
	if (credential?.kind === 'token') {
		error(403, 'An API token cannot be used on a page. Use the /api routes.');
	}

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
	return requireApi(locals, { role: needed, ability: 'read' }).principal;
}

/** What {@link requireApi} returns: who, and what they were allowed to do it with. */
export interface ApiCaller {
	readonly principal: Principal;
	readonly credential: Credential;
}

/**
 * The full API guard: a role, and an ability the credential must carry.
 *
 * Two checks rather than one, because they refuse different things. The **role** is about the
 * person — whether this is theirs to touch at all. The **ability** is about the credential — whether
 * the thing presenting it was trusted to change anything. An owner's read-only token holds the
 * widest role in the installation and still cannot write, which is the entire point of issuing one.
 *
 * ### Why a write endpoint must say so
 *
 * `ability` has no default here, and {@link requireRoleForApi} passes `'read'` because every caller
 * it has is a read. A defaulted ability would mean the first write endpoint somebody adds is
 * permitted to a read-only token through nothing but forgetting a parameter — and the failure would
 * be silent, because the endpoint would work perfectly when they tested it with their own cookie.
 *
 * ### The statuses
 *
 * 401 for "present a credential", 403 for "that credential is not enough". A client can act on the
 * distinction: the first means try again with one, the second means do not bother retrying. A token
 * refused for its ability gets a message saying so, because the alternative is somebody debugging
 * their role for an hour over a credential they could have reissued in a minute.
 */
export function requireApi(
	locals: Signed,
	needed: { readonly role: Role; readonly ability: Ability }
): ApiCaller {
	const { principal, credential } = locals;

	if (principal === null || principal === undefined) error(401, 'Not signed in.');

	// Should be impossible — `hooks.server.ts` sets both or neither — and refused rather than
	// assumed, because the assumption that would let this through is "it must be a session".
	if (credential === null || credential === undefined) error(401, 'Not signed in.');

	if (!atLeast(principal.role, needed.role)) error(403, 'Not allowed.');

	if (credential.kind === 'token' && !permits(credential.ability, needed.ability)) {
		error(403, 'This API token may only read.');
	}

	return { principal, credential };
}

/** Shorthand used where a route has nothing but a role requirement. */
export function forbid(): never {
	error(403, 'Not allowed.');
}
