/**
 * Which ways of signing in this installation has.
 *
 * **Derived, not declared.** This used to hold its own array of providers, which meant a platform
 * could appear in the platform registry and not here, or be linkable and not sign-in-able, with
 * nothing to notice. The one list is `./platform-registry.ts`; signing in is the platforms that
 * declare the `sign-in` capability and have an OAuth half this installation can use.
 *
 * The functions stay because the sign-in routes are about *signing in*, and asking them "which
 * provider is `discord`" reads better at the callsite than asking the platform registry for a
 * platform and then reaching into its `oauth` field.
 */

import { accountPlatform, platformsFor } from './platform-registry.js';
import type { SignInProvider } from './sign-in-provider.js';

/**
 * Providers a visitor can actually use, in the order they should be offered.
 *
 * Empty on an install where nobody has configured anything, which the sign-in page says out loud
 * rather than rendering a page with no buttons on it.
 */
export function signInProviders(): readonly SignInProvider[] {
	return platformsFor('sign-in')
		.map((entry) => entry.oauth)
		.filter((provider): provider is SignInProvider => provider?.usable() === true);
}

/**
 * One provider by its kind, or null.
 *
 * Null both for a kind nobody implements and for one that is implemented but not configured. The
 * route cannot usefully tell those apart — a visitor who reached `/auth/google/login` on a site with
 * no Google application gets the same 404 either way — and collapsing them means a probe cannot
 * enumerate which providers a build supports but has not set up.
 */
export function signInProvider(kind: string): SignInProvider | null {
	return signInProviders().find((provider) => provider.kind === kind) ?? null;
}

/** Whether signing in is possible at all on this install. */
export function signInConfigured(): boolean {
	return signInProviders().length > 0;
}

/**
 * One provider by kind for a *link* flow, whether or not it can sign anybody in.
 *
 * ### The gap this closes
 *
 * `./platform.ts` says capabilities and methods are two independent lists, and the account page
 * relies on that — but both `/auth/<kind>/login` and its callback resolved the provider through
 * {@link signInProvider}, which filters by the `sign-in` capability. So a platform that can be
 * linked but cannot sign anybody in was unreachable: the account page would offer the link and the
 * route would answer 404. The two lists were independent everywhere except where it mattered.
 *
 * YouTube is the first platform like that, and it is the common case rather than the exception —
 * a creator links it to show a channel, not to log in, and making it a sign-in provider would mean
 * requesting a heavy scope for sign-in and failing for anybody without a channel.
 *
 * ### Why this is not a hole
 *
 * It is deliberately permissive, because the callback cannot know what the flow was for: the intent
 * lives in the signed cookie, which only `./flow.ts` reads. So the capability is enforced there,
 * against the cookie, once — see `completeSignIn`. A `sign-in` or `link` intent on a platform that
 * does not declare `sign-in` is refused at that point, which is the only place that knows both
 * halves.
 *
 * Resolving permissively here and checking there is the right way round. The alternative — the
 * route guessing the intent from a query parameter it also controls — would be a check against a
 * value the request supplies.
 */
export function linkProvider(kind: string): SignInProvider | null {
	const platform = accountPlatform(kind);

	if (platform?.usable('oauth') !== true) return null;

	// Both halves, because a platform can declare `oauth` and have no provider behind it on a build
	// where the dependency is absent — and `usable()` on the provider is what reads the environment.
	return platform.oauth?.usable() === true ? platform.oauth : null;
}
