/**
 * The sign-in page's data: which buttons to offer, and anything to say first.
 *
 * It says out loud when sign-in is not set up. A page offering a button that leads to a provider's
 * own error screen is worse than one saying the site has not been configured, because the visitor
 * cannot tell which end is broken — and on a self-hosted product the visitor is quite often the
 * person who has to fix it.
 */

import { redirect } from '@sveltejs/kit';
import { hasNamedAdmins } from '#lib/server/config.js';
import { isUnclaimed } from '#lib/server/accounts.js';
import { safePath } from '#lib/server/auth/flow.js';
import { signInProviders } from '#lib/server/auth/sign-in-registry.js';
import type { PageServerLoad } from './$types';

/** How long a message passed through the URL may be before it is ignored. */
const REASON_LIMIT = 200;

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safePath(url.searchParams.get('next'));

	// Already signed in: there is nothing to do here. Sent on rather than shown a sign-in page with
	// their own name on it, which reads like the sign-in failed.
	if (locals.principal !== null) redirect(303, next);

	const raw = url.searchParams.get('reason') ?? '';

	return {
		next,
		providers: signInProviders().map((provider) => ({
			kind: provider.kind,
			label: provider.label
		})),

		// Rendered as text by the page, never as markup. It arrives in a URL anybody can write, so
		// the length cap is there to stop a crafted link turning the page into a billboard.
		reason: raw.length > 0 && raw.length <= REASON_LIMIT ? raw : null,

		/**
		 * Whether the next person to sign in will own this installation.
		 *
		 * Said plainly on the page. It is the one moment where the honest description of what is about
		 * to happen is also a warning, and hiding it would not make it less true.
		 */
		claimable: isUnclaimed() && !hasNamedAdmins()
	};
};
