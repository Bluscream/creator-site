/**
 * Which ways of signing in this installation has.
 *
 * The same shape as `providers/posts-registry.ts` and for the same reason: one array, and adding a
 * provider is adding an entry to it. Nothing else in the application enumerates providers, so
 * nothing else has to be found and edited when a second one arrives.
 */

import { discordSignIn } from './discord-sign-in.js';
import type { SignInProvider } from './sign-in-provider.js';

/**
 * Every provider this build knows how to sign in with.
 *
 * Built once. A provider's constructor assigns strings and reads nothing, and `usable()` is what
 * reports whether it is configured — so this list is the same on a bare install as on a configured
 * one, and the difference shows up as a button that is not offered rather than as a provider that
 * is not there.
 */
const PROVIDERS: readonly SignInProvider[] = [discordSignIn()];

/**
 * Providers a visitor can actually use, in the order they should be offered.
 *
 * Empty on an install where nobody has configured anything, which the sign-in page says out loud
 * rather than rendering a page with no buttons on it.
 */
export function signInProviders(): readonly SignInProvider[] {
	return PROVIDERS.filter((provider) => provider.usable());
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
