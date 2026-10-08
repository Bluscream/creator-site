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
import { INTENTS, beginSignIn } from '#lib/server/auth/flow.js';
import { signInProvider } from '#lib/server/auth/sign-in-registry.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const provider = signInProvider(event.params.provider);
	const { principal } = event.locals;

	// 404 both for a provider nobody implements and for one that is not configured. A visitor cannot
	// act on the difference, and collapsing them means a probe cannot enumerate which providers this
	// build supports but has not been given credentials for.
	if (provider === null) error(404, 'No such sign-in method.');

	// `?intent=link` is "add this as another way to sign in to the account I am already using";
	// `?intent=connect` is "link this platform account so the site can use it", which writes a
	// `connections` row instead of an `identities` one. Both are honoured only for somebody who *is*
	// signed in — for anybody else the flow has no account to attach anything to, so it falls back to
	// an ordinary sign-in rather than failing on the way back from the provider.
	const asked = event.url.searchParams.get('intent');
	const intent = INTENTS.find((known) => known === asked) ?? 'sign-in';
	const options =
		intent === 'sign-in' || principal === null ? {} : { intent, userId: principal.userId };

	redirect(303, (await beginSignIn(provider, event, options)).toString());
};
