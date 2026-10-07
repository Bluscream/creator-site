/**
 * Who may sign in, and what they get when they do.
 *
 * Two questions, kept out of both the flow and the account store: the flow should not decide policy,
 * and the account store should not read the environment.
 *
 * ### The bootstrap list
 *
 * `ADMIN_ACCOUNTS` names the people who administer *this* installation, as `provider:id` pairs. An
 * account it names is an `admin` the moment it exists, and is raised to `admin` if it somehow ended
 * up lower — so the creator can always get back into their own site, even with an empty database,
 * even if they demoted themselves by accident. It is the escape hatch that makes the rest of the
 * role system safe to use.
 *
 * It also narrows the one genuinely uncomfortable property of `accounts.ts`: on an unclaimed
 * install, whoever signs in first becomes the owner. With this set, a stranger who got there first
 * would be the owner of an install whose real administrator can still sign in and demote them. With
 * it unset, nothing stops them — which is why `.env.example` says to set it before exposing a fresh
 * install to the internet.
 *
 * **Ids, never names.** A username can be changed by its owner and then registered by somebody
 * else; a provider's own id cannot. An entry that is not `provider:id` is dropped rather than kept
 * as something a string comparison might accidentally match, and an empty list means nobody is
 * named — which is the right reading of a missing setting.
 *
 * ### Registration
 *
 * Off unless `ALLOW_REGISTRATION` says otherwise. Turning it on hands the creator a moderation
 * queue, deletion requests and abuse reports, and that should be a decision rather than something
 * that happened. This will move into the config document once the admin can edit it; the function is
 * here so that when it does, one body changes.
 */

import { ADMIN_ACCOUNTS, ALLOW_REGISTRATION } from '$app/env/private';
import type { ProviderIdentity } from '../accounts.js';
import type { Role } from '../db/schema.js';

/** Whether an identity nobody has seen before may become an account. */
export function registrationPolicy(): { readonly register: boolean } {
	return { register: ALLOW_REGISTRATION };
}

/**
 * The lowest role an identity is entitled to, or null for no opinion.
 *
 * A floor rather than an assignment: somebody named here who is already the `owner` stays the owner.
 * Raising, never lowering — the environment says who must be able to administer the site, not who
 * must not.
 */
export function roleFloorFor(identity: ProviderIdentity): Role | null {
	return isNamedAdmin(identity) ? 'admin' : null;
}

/** Whether the bootstrap list names this identity. */
export function isNamedAdmin(identity: ProviderIdentity): boolean {
	return ADMIN_ACCOUNTS.includes(`${identity.provider}:${identity.providerUserId}`);
}

/** Whether anybody is named at all. Reported by the setup page, not used as a gate. */
export function namedAdmins(): number {
	return ADMIN_ACCOUNTS.length;
}
