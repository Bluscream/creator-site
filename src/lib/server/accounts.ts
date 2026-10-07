/**
 * Accounts, and turning a provider identity into one.
 *
 * A person is a {@link users} row; the ways they sign in are {@link identities} rows. That split is
 * the whole design: somebody who signs in with Discord today and adds Google tomorrow is one
 * account, and the thing that owns their role is not either provider.
 *
 * ### Registration is off unless it is on
 *
 * {@link signIn} takes a policy rather than deciding for itself. An unknown identity with
 * `register: false` is refused, which is the default an installation ships with — turning it on
 * hands the creator a moderation queue, deletion requests and abuse reports, and that should be a
 * decision rather than something that happened. The admin's own sign-in works regardless, because
 * their identity already exists.
 *
 * ### The first account is the owner
 *
 * An installation with no users hands `owner` to whoever signs in first. That is how first-run setup
 * works without a password printed in a log or baked into an environment variable: the person who
 * reaches a fresh install first is the person setting it up. Everyone after gets
 * {@link DEFAULT_ROLE}, and it is left to the owner to promote them.
 *
 * This is a real exposure window on a fresh install reachable from the internet, and naming it is
 * better than pretending otherwise: whoever signs in first owns the site. The mitigation is that the
 * window closes at the first sign-in, not that it does not exist.
 */

import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { DEFAULT_ROLE, ROLES, identities, users } from './db/schema.js';
import type { Role } from './db/schema.js';
import { log } from './log.js';
import type { Principal } from './session.js';

/** What a provider told us about the person signing in. */
export interface ProviderIdentity {
	/** `discord`, `google`, `twitch` — whichever provider this came from. */
	readonly provider: string;

	/** The provider's own id for the person. Never an email, which people change. */
	readonly providerUserId: string;

	/** A display name. Falls back to the provider name, because the column is not nullable. */
	readonly name?: string;

	/** An absolute `https` avatar url, or absent. */
	readonly avatarUrl?: string;
}

/** Why a sign-in did not produce an account. */
export type SignInRefusal =
	| { readonly ok: false; readonly reason: 'registration_closed' }
	| { readonly ok: false; readonly reason: 'invalid_identity' };

/** A sign-in that worked, or why it did not. */
export type SignInResult =
	{ readonly ok: true; readonly principal: Principal; readonly created: boolean } | SignInRefusal;

/**
 * A stored role, checked.
 *
 * The column is a typed string rather than a check constraint, so the type system believes whatever
 * is in the database. This is where that belief is verified: a row holding something that is not a
 * role — a hand edit, a downgrade from a future version that added one — resolves to the *narrowest*
 * role rather than being trusted or throwing. Failing closed is the only safe direction for a value
 * that decides what somebody may do.
 */
export function roleOf(value: string): Role {
	if ((ROLES as readonly string[]).includes(value)) return value as Role;

	log().error(
		{ role: value },
		'a user row holds a role that does not exist; treating as the least'
	);

	return DEFAULT_ROLE;
}

/** Whether this installation has any accounts at all. */
export function isUnclaimed(): boolean {
	const [row] = db().select({ total: count() }).from(users).all();

	return (row?.total ?? 0) === 0;
}

/** The principal for a user row, with the role checked. */
function principalOf(row: {
	id: string;
	name: string;
	avatarUrl: string | null;
	role: string;
}): Principal {
	return {
		userId: row.id,
		name: row.name,
		avatarUrl: row.avatarUrl,
		role: roleOf(row.role)
	};
}

/** The user an identity belongs to, or null. */
export function findByIdentity(provider: string, providerUserId: string): Principal | null {
	const [found] = db()
		.select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl, role: users.role })
		.from(identities)
		.innerJoin(users, eq(users.id, identities.userId))
		.where(and(eq(identities.provider, provider), eq(identities.providerUserId, providerUserId)))
		.all();

	return found === undefined ? null : principalOf(found);
}

/**
 * Signs somebody in, creating the account if the policy allows it.
 *
 * @param policy  `register` decides what happens to an identity nobody has seen before.
 * @param options `floor` is the lowest role this identity is entitled to, from
 *                `auth/policy.ts` — the environment naming who administers this install. Applied to
 *                a new account and to a returning one, raising only: somebody named as an admin who
 *                is already the owner stays the owner. This is the escape hatch that makes the role
 *                system safe to use, because a creator who demoted themselves can still get back in.
 */
export function signIn(
	identity: ProviderIdentity,
	policy: { readonly register: boolean },
	options?: { readonly floor?: Role | null }
): SignInResult {
	if (identity.provider === '' || identity.providerUserId === '') {
		// Not a validation nicety: an empty provider id would make one `identities` row match every
		// future sign-in that also failed to supply one.
		return { ok: false, reason: 'invalid_identity' };
	}

	const floor = options?.floor ?? null;
	const existing = findByIdentity(identity.provider, identity.providerUserId);

	if (existing !== null)
		return { ok: true, principal: raised(refreshed(existing, identity), floor), created: false };

	// The first account to exist owns the installation; see the note at the top. Checked before the
	// registration policy, because a fresh install has to be claimable even with registration off —
	// which is the state it ships in.
	const first = isUnclaimed();

	if (!first && !policy.register) return { ok: false, reason: 'registration_closed' };

	const role = first ? 'owner' : (floor ?? DEFAULT_ROLE);

	return { ok: true, principal: create(identity, role), created: true };
}

/**
 * Raises a principal to at least `floor`, writing the new role if it changed.
 *
 * Raising only. {@link ROLES} is widest first, so "at least" is a lower index — and an owner named
 * as an admin in the environment keeps the wider role rather than being quietly demoted to match a
 * setting that was only ever meant to let them in.
 */
function raised(principal: Principal, floor: Role | null): Principal {
	if (floor === null) return principal;

	const held = ROLES.indexOf(principal.role);
	const least = ROLES.indexOf(floor);

	if (held <= least) return principal;

	db().update(users).set({ role: floor }).where(eq(users.id, principal.userId)).run();

	log().info({ from: principal.role, to: floor }, 'role raised to the configured floor');

	return { ...principal, role: floor };
}

/**
 * Creates the user and the identity as one unit.
 *
 * A transaction because a user with no identity cannot sign in and an identity with no user is a
 * foreign-key violation waiting to happen. Either both rows exist or neither does.
 */
function create(identity: ProviderIdentity, role: Role): Principal {
	const id = randomUUID();
	const name = identity.name ?? identity.provider;
	const avatarUrl = identity.avatarUrl ?? null;

	db().transaction((tx) => {
		tx.insert(users).values({ id, name, avatarUrl, role }).run();
		tx.insert(identities)
			.values({
				provider: identity.provider,
				providerUserId: identity.providerUserId,
				userId: id
			})
			.run();
	});

	log().info({ provider: identity.provider, role }, 'account created');

	return { userId: id, name, avatarUrl, role };
}

/**
 * Updates a returning user's name and picture from the provider.
 *
 * People rename themselves and change their avatars, and a site showing a two-year-old display name
 * looks broken. Only written when something actually differs, so an ordinary sign-in is a read.
 *
 * The *role* is never touched here. It belongs to this installation, not to Discord.
 */
function refreshed(principal: Principal, identity: ProviderIdentity): Principal {
	const name = identity.name ?? principal.name;
	const avatarUrl = identity.avatarUrl ?? principal.avatarUrl;

	if (name === principal.name && avatarUrl === principal.avatarUrl) return principal;

	db().update(users).set({ name, avatarUrl }).where(eq(users.id, principal.userId)).run();

	return { ...principal, name, avatarUrl };
}

/**
 * Adds another way for an existing user to sign in.
 *
 * @returns false when that identity already belongs to somebody — including to this same user, where
 *          there is nothing to add. Refusing rather than reassigning, because moving an identity
 *          between accounts is how one person takes over another's.
 */
export function linkIdentity(userId: string, identity: ProviderIdentity): boolean {
	if (findByIdentity(identity.provider, identity.providerUserId) !== null) return false;

	db()
		.insert(identities)
		.values({
			provider: identity.provider,
			providerUserId: identity.providerUserId,
			userId
		})
		.run();

	return true;
}

/** Every way a user can sign in. */
export function identitiesOf(userId: string): readonly { readonly provider: string }[] {
	return db()
		.select({ provider: identities.provider })
		.from(identities)
		.where(eq(identities.userId, userId))
		.all();
}

/**
 * Removes one way of signing in.
 *
 * @returns false when it was the last one. Removing it would leave an account nobody can reach,
 *          which is a support request rather than a thing to allow.
 */
export function unlinkIdentity(userId: string, provider: string): boolean {
	if (identitiesOf(userId).length <= 1) return false;

	const removed = db()
		.delete(identities)
		.where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
		.run().changes;

	return removed > 0;
}
