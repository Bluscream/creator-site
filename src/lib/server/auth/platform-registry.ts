/**
 * Which platforms this build can link an account to.
 *
 * One array, the same shape as `providers/posts-registry.ts` and `./sign-in-registry.ts`, and for
 * the same reason: adding a platform is adding an entry. Nothing else enumerates platforms, so
 * nothing else has to be found and edited when the second one arrives.
 *
 * ### This is now the one list, and signing in reads it
 *
 * `./sign-in-registry.ts` used to hold its own array of sign-in providers. It now filters this one
 * for the platforms that declare the `sign-in` capability, so a platform cannot be linkable and
 * un-sign-in-able by accident, or appear in one list and not the other.
 */

import { discordPlatform } from './discord-platform.js';
import { kickPlatform } from './kick-platform.js';
import { twitchPlatform } from './twitch-platform.js';
import { linkable, supports } from './platform.js';
import type { AccountPlatform, Capability } from './platform.js';

/**
 * Every platform this build knows about, configured or not.
 *
 * Built once at module load. A platform's factory assigns strings and reads nothing; `usable()` is
 * what consults the environment — so this list is identical on a bare install and a configured one,
 * and the difference shows up as a method that is not offered rather than a platform that is not
 * there. Which also means a probe cannot tell from the shape of the site which platforms the
 * operator has set up.
 */
const PLATFORMS: readonly AccountPlatform[] = [discordPlatform(), twitchPlatform(), kickPlatform()];

/** Every platform, including the ones this installation cannot link. */
export function accountPlatforms(): readonly AccountPlatform[] {
	return PLATFORMS;
}

/**
 * Platforms this installation can actually link, in registry order.
 *
 * Empty on an install where nothing has been configured, which the account page says out loud rather
 * than rendering a page with no buttons on it.
 */
export function linkablePlatforms(): readonly AccountPlatform[] {
	return PLATFORMS.filter((entry) => linkable(entry));
}

/**
 * Linkable platforms that could serve a capability.
 *
 * What an admin page asks when it wants to say "chat needs a linked account on one of these".
 */
export function platformsFor(capability: Capability): readonly AccountPlatform[] {
	return linkablePlatforms().filter((entry) => supports(entry, capability));
}

/**
 * One platform by id, or null.
 *
 * Null both for an id nobody implements and for one that is implemented but not configured, exactly
 * as `signInProvider` does and for the same reason: the two are indistinguishable to the person who
 * reached the URL, and collapsing them means a probe cannot enumerate what this build supports but
 * the operator has not set up.
 */
export function accountPlatform(id: string): AccountPlatform | null {
	return linkablePlatforms().find((entry) => entry.id === id) ?? null;
}
