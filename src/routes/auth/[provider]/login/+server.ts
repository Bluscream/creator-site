/**
 * Starts a sign-in: `/auth/discord/login`.
 *
 * A `GET` that redirects, which is what a sign-in button has to be — the visitor is going to a
 * different site, and that is a navigation rather than a form submission. Nothing on this site is
 * changed by it: the only side effect is a short-lived cookie holding the `state` to compare on the
 * way back.
 *
 * The provider is a route parameter rather than a query one so that each provider's callback has its
 * own registered redirect URI, which is what every provider's console expects.
 */

import { error, redirect } from '@sveltejs/kit';
import { beginSignIn } from '#lib/server/auth/flow.js';
import { signInProvider } from '#lib/server/auth/sign-in-registry.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const provider = signInProvider(event.params.provider);

	// 404 both for a provider nobody implements and for one that is not configured. A visitor cannot
	// act on the difference, and collapsing them means a probe cannot enumerate which providers this
	// build supports but has not been given credentials for.
	if (provider === null) error(404, 'No such sign-in method.');

	// A visitor who is already signed in and lands here is starting a sign-in anyway — adding another
	// identity, or switching accounts. Issuing a second session is correct, and the old one stays
	// revocable.
	redirect(303, beginSignIn(provider, event).toString());
};
