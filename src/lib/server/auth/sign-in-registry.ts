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

import { platformsFor } from './platform-registry.js';
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
