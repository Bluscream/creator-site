/**
 * Signing out: `POST /auth/sign-out`.
 *
 * `POST` rather than `GET`, and that is the whole design decision worth recording. A sign-out on a
 * `GET` can be triggered by anything that makes the browser issue a request — an `<img>` on another
 * site, a link preview, an over-eager prefetcher — and the result is a creator who keeps being
 * signed out and cannot work out why. SvelteKit refuses a cross-origin form `POST` by default, so a
 * `POST` is also the form that cannot be forged.
 *
 * The session row is deleted, not just the cookie. Clearing the cookie alone would leave a usable
 * credential in whatever read it — which is the reason sessions are rows in the first place.
 */

import { redirect } from '@sveltejs/kit';
import { safePath, signOut } from '#lib/server/auth/flow.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	signOut(event);

	// Where to land afterwards, from the form that submitted. Reduced by `safePath`, so a crafted
	// sign-out form cannot use the redirect as a bounce to somewhere else. The public site is the
	// fallback: somebody who has just signed out should not be sent to a page that signs them in.
	// `get` can also return a `File`, which a crafted multipart submission is free to send. Only a
	// string is a path; anything else falls through to the default.
	const submitted = (await event.request.formData()).get('next');
	const next = safePath(typeof submitted === 'string' ? submitted : null, '/');

	redirect(303, next);
};
