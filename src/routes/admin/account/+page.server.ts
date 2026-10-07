/**
 * Your own account: how you sign in, and where you are signed in.
 *
 * The first admin page with form actions, and the shape here is the one the rest will follow.
 * Everything is a `POST` with progressive enhancement, every action re-reads the session rather than
 * trusting a field, and nothing identifies a row by anything the browser could have swapped for
 * somebody else's.
 *
 * ### Showing session ids is deliberate
 *
 * A session row's id is the SHA-256 of its token, which cannot be turned back into a cookie. So the
 * page can list sessions and end one by id without ever putting a credential in a form. That is the
 * payoff for keying the table by a hash rather than by the token.
 *
 * Every action is still scoped to the signed-in user in the query itself, not checked against a
 * field, because an id in a form arrives from outside the trust boundary whatever the page believes
 * it rendered.
 */

import { fail } from '@sveltejs/kit';
import { identitiesOf, unlinkIdentity } from '#lib/server/accounts.js';
import { requireSignIn } from '#lib/server/auth/guard.js';
import { signInProviders } from '#lib/server/auth/sign-in-registry.js';
import {
	SESSION_COOKIE,
	revokeAll,
	revokeById,
	sessionIdFor,
	sessionsOf
} from '#lib/server/session.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, locals, url }) => {
	const principal = requireSignIn(locals, url);
	const linked = identitiesOf(principal.userId).map((row) => row.provider);

	return {
		identities: linked,

		// Providers this install has that this account has not linked yet. Offered rather than listed
		// as "not linked", because the useful thing to show is the button.
		linkable: signInProviders()
			.filter((provider) => !linked.includes(provider.kind))
			.map((provider) => ({ kind: provider.kind, label: provider.label })),

		// `unlink` refuses the last one, and the page should not offer what will be refused.
		canUnlink: linked.length > 1,

		sessions: sessionsOf(principal.userId, cookies.get(SESSION_COOKIE))
	};
};

export const actions: Actions = {
	/** Ends one session — "this device is not mine any more". */
	endSession: async ({ cookies, locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const id = field(await request.formData(), 'id');

		if (id === null) return fail(400, { error: 'no_session' });

		// Ending the current one is signing out, and the cookie has to go with it or the next request
		// arrives with a token whose row is gone. Harmless, but it would look like a bug.
		const token = cookies.get(SESSION_COOKIE);

		if (token !== undefined && id === sessionIdFor(token)) {
			revokeById(principal.userId, id);
			cookies.delete(SESSION_COOKIE, { path: '/' });

			return { signedOut: true };
		}

		return revokeById(principal.userId, id) ? { ended: true } : fail(404, { error: 'no_session' });
	},

	/** Signs out everywhere else, keeping this device. */
	endOthers: ({ cookies, locals, url }) => {
		const principal = requireSignIn(locals, url);
		const token = cookies.get(SESSION_COOKIE);
		const ended =
			token === undefined
				? revokeAll(principal.userId)
				: revokeAll(principal.userId, { except: token });

		return { ended };
	},

	/** Removes a way of signing in. */
	unlink: async ({ locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const provider = field(await request.formData(), 'provider');

		if (provider === null) return fail(400, { error: 'no_provider' });

		// Refused when it is the last one: removing it would leave an account nobody can reach, which
		// is a support request rather than a thing to allow.
		return unlinkIdentity(principal.userId, provider)
			? { unlinked: true }
			: fail(409, { error: 'last_identity' });
	}
};

/**
 * One form field, as a string.
 *
 * `get` can also return a `File`, which a crafted multipart submission is free to send, and only a
 * string is an answer to any of these questions.
 */
function field(data: FormData, name: string): string | null {
	const value = data.get(name);

	return typeof value === 'string' && value !== '' ? value : null;
}
