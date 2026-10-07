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
	const { principal } = event.locals;

	// 404 both for a provider nobody implements and for one that is not configured. A visitor cannot
	// act on the difference, and collapsing them means a probe cannot enumerate which providers this
	// build supports but has not been given credentials for.
	if (provider === null) error(404, 'No such sign-in method.');

	// `?intent=link` is "add this as another way to sign in to the account I am already using", from
	// the account page. Honoured only for somebody who *is* signed in; for anybody else it is an
	// ordinary sign-in, because a link flow with no account to link to has nothing to do.
	const link = event.url.searchParams.get('intent') === 'link' && principal !== null;
	const options = link ? { intent: 'link' as const, userId: principal.userId } : {};

	redirect(303, beginSignIn(provider, event, options).toString());
};
