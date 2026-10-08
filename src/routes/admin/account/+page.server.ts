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
import { keepGrant } from '#lib/server/auth/flow.js';
import { offeredMethods } from '#lib/server/auth/platform.js';
import { accountPlatform, linkablePlatforms } from '#lib/server/auth/platform-registry.js';
import { SignInFailure } from '#lib/server/auth/sign-in-provider.js';
import { log } from '#lib/server/log.js';
import { signInProviders } from '#lib/server/auth/sign-in-registry.js';
import { platformToken } from '#lib/server/auth/token.js';
import { connectionsOf, setShown, unlink } from '#lib/server/connections.js';
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

		sessions: sessionsOf(principal.userId, cookies.get(SESSION_COOKIE)),

		// The page-safe shape, which structurally cannot carry a token. Passed through as it is: the
		// expiry arithmetic is already done by `connectionsOf`, so the template has no dates to
		// reason about.
		connections: connectionsOf(principal.userId),

		/**
		 * Platforms that can be linked, each with what a link to it is good for.
		 *
		 * Every platform, not only the unlinked ones — re-authorising an existing link is the ordinary
		 * way a lapsed token is fixed, and a page that hid the button after the first link would make
		 * the fix impossible to find. `caveat` is carried so an honest limitation is shown where
		 * somebody is deciding whether to link, rather than discovered as a feed that stays empty.
		 */
		platforms: linkablePlatforms().map((entry) => ({
			id: entry.id,
			label: entry.label,
			capabilities: entry.capabilities,
			// Resolved here, where the request's locale is known, so the page receives a sentence
			// rather than a function it could not serialise.
			caveat: entry.caveat === null ? null : entry.caveat(),
			methods: offeredMethods(entry),

			// What to paste and where to get it, for the platforms that take a token. Null rather than
			// absent so the template's check is one thing; the hint is platform-specific by necessity
			// — "a Twitch user token from the CLI" and "a Google API key" are not one instruction.
			tokenHint: offeredMethods(entry).includes('token') ? (entry.token?.hint ?? null) : null
		}))
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

	/**
	 * Links an account from a token somebody pasted.
	 *
	 * The only action here that handles a credential, so it is the one with the most to get wrong:
	 *
	 * - the token is **verified against the platform before anything is stored**, because the failure
	 *   modes of a wrong one are a feed that silently stays empty and a live badge that never lights,
	 *   neither of which points back at this form;
	 * - the platform comes from the registry, not from the field — a form naming a platform this
	 *   install does not offer is refused rather than looked up;
	 * - nothing about the token, not even its length, is logged or returned. The refusal the person
	 *   sees comes from the platform's own verifier, which is written never to quote the credential.
	 */
	linkToken: async ({ locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const data = await request.formData();
		const id = field(data, 'platform');
		const token = field(data, 'token');

		if (id === null || token === null) return fail(400, { error: 'no_token' });

		const platform = accountPlatform(id);

		// `accountPlatform` already excludes what this install cannot link, so one lookup answers
		// both "does this exist" and "is it configured".
		if (platform === null || !platform.methods.includes('token') || platform.token === null) {
			return fail(404, { error: 'no_platform' });
		}

		if (!platform.usable('token')) return fail(409, { error: 'no_platform' });

		try {
			const grant = await platform.token.verify(token);

			keepGrant(grant, principal.userId, 'token');
		} catch (cause) {
			// The verifier's own message, which is written for the person who pasted it. Anything else
			// is a bug or the network, and its message could carry anything — including the request
			// that was rejected — so it is replaced rather than shown.
			if (cause instanceof SignInFailure) return fail(400, { error: cause.message });

			log().error({ platform: id, err: messageOf(cause) }, 'linking by token failed');

			return fail(502, { error: 'link_failed' });
		}

		return { linked: true };
	},

	/**
	 * Checks a linked account, renewing its token first if that is what it needs.
	 *
	 * The button exists because the alternative way to find out is to wait for a feed to stop
	 * filling. A linked Twitch account's access token lasts about four hours, so a link made
	 * yesterday is almost certainly stale, and nothing on the page could previously tell the
	 * difference between stale-but-renewable and genuinely broken.
	 *
	 * Reports only whether there is a usable token now. Never the token, and never which of the
	 * several failures it was: `platformToken` logs those where they happen, and a creator's next
	 * step is the same for all of them.
	 */
	checkConnection: async ({ locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const id = field(await request.formData(), 'platform');

		if (id === null) return fail(400, { error: 'no_platform' });

		// Checked against the registry rather than trusted from the form, as everywhere else here: the
		// value arrived from outside the trust boundary whatever the page believes it rendered.
		if (accountPlatform(id) === null) return fail(404, { error: 'no_platform' });

		// Scoped to the owner before anything is read: an id from a form is not a claim about whose
		// connection it is.
		if (!connectionsOf(principal.userId).some((entry) => entry.platform === id)) {
			return fail(404, { error: 'no_connection' });
		}

		return { working: (await platformToken(id)) !== null };
	},

	/** Shows or hides a linked account on the public site. */
	showConnection: async ({ locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const data = await request.formData();
		const id = field(data, 'id');

		if (id === null) return fail(400, { error: 'no_connection' });

		// The desired state is sent rather than toggled, so a double submission — a slow network and
		// an impatient click — lands on the state the person asked for instead of back where it was.
		const shown = field(data, 'shown') === 'true';

		return setShown(principal.userId, id, shown)
			? { shown }
			: fail(404, { error: 'no_connection' });
	},

	/** Removes a linked account, and the credential with it. */
	unlinkConnection: async ({ locals, request, url }) => {
		const principal = requireSignIn(locals, url);
		const id = field(await request.formData(), 'id');

		if (id === null) return fail(400, { error: 'no_connection' });

		// Scoped to the owner in the query, not checked against this form: the id arrived from
		// outside the trust boundary whatever the page believes it rendered.
		return unlink(principal.userId, id)
			? { unlinked: true }
			: fail(404, { error: 'no_connection' });
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
 * An unknown throwable's message, for a log line.
 *
 * `String(cause)` on an arbitrary value can run a `toString` the thrower controls, and an `Error`
 * subclass can carry a response body in its message — so this takes the message only from a real
 * `Error` and names the type otherwise.
 */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.name : typeof cause;
}

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
