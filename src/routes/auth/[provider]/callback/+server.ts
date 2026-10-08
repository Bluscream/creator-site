/**
 * Finishes a sign-in: `/auth/discord/callback`.
 *
 * Where the provider sends the visitor back. Everything that could go wrong here is somebody else's
 * timing — a declined prompt, an expired code, a cookie that aged out in another tab — so a failure
 * ends up back on the sign-in page with a sentence saying what happened, rather than on an error
 * page. The visitor's next action is the same in every case: press the button again.
 *
 * The reason is carried in the URL rather than in a flash cookie because this is a `GET` that
 * redirects, and a one-shot cookie read on the next request is a second thing to get wrong for a
 * message nobody keeps.
 */

import { error, redirect } from '@sveltejs/kit';
import { SIGN_IN_PATH } from '#lib/server/auth/guard.js';
import { ACCOUNT_PATH } from '#lib/server/auth/flow.js';
import { completeSignIn } from '#lib/server/auth/flow.js';
import { SignInFailure } from '#lib/server/auth/sign-in-provider.js';
import { linkProvider } from '#lib/server/auth/sign-in-registry.js';
import { log } from '#lib/server/log.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	// Permissive: the callback cannot know what the flow was for, because the intent is in the signed
	// cookie that `completeSignIn` reads. It enforces the capability there, which is the only place
	// that knows both the intent and the platform.
	const provider = linkProvider(event.params.provider);

	if (provider === null) error(404, 'No such sign-in method.');

	let destination: string;

	try {
		// The signed-in principal, for a `link` flow — which attaches the identity that comes back to
		// the account already in use rather than signing in as it.
		destination = (await completeSignIn(provider, event, event.locals.principal)).next;
	} catch (cause) {
		// A `SignInFailure` is a message written to be read by the person who hit it. Anything else is
		// a bug, and is logged with its cause and reported as the same sentence — a visitor cannot act
		// on a stack trace, and an exception message from a dependency may quote a request.
		if (!(cause instanceof SignInFailure)) {
			log().error({ err: cause, provider: provider.kind }, 'sign-in failed unexpectedly');
		}

		const reason =
			cause instanceof SignInFailure ? cause.message : 'Something went wrong signing in.';

		// Somebody already signed in was adding another way to sign in, not signing in. Sending them to
		// the sign-in page would read as "you have been signed out", which is both alarming and untrue.
		const page = event.locals.principal === null ? SIGN_IN_PATH : ACCOUNT_PATH;

		redirect(303, `${page}?reason=${encodeURIComponent(reason)}`);
	}

	redirect(303, destination);
};
