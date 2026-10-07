/**
 * Linked platform accounts: storing them, reading them, and handing out their credentials.
 *
 * One account, every purpose. A `connections` row is not "a credential for the post feed" — it is an
 * account somebody linked, and what it can be used for follows from its platform and the scopes the
 * platform granted. The links page reads it for a handle, the post reader for a token, the live badge
 * for a channel id. An environment variable could serve exactly one of those, which is why adding a
 * platform used to mean touching three places.
 *
 * ### Two shapes, deliberately
 *
 * {@link Connection} is what a page may see: who, where, when, and what it can do. It carries **no
 * secret**, so a `load` function cannot accidentally serialise a token into a page's props — which is
 * the mistake this split exists to make impossible rather than to warn about.
 *
 * {@link Credential} is what a provider needs, and getting one is an explicit call
 * ({@link credentialFor}) that decrypts on the way out. Nothing else returns a token.
 *
 * ### Why the secret is decrypted per read rather than cached
 *
 * A decrypted token held in a module-level map is a token in a heap dump, and the saving is a few
 * hundred microseconds on a request that is about to make a network call anyway. The read is a
 * single-row primary-key lookup plus one AES-GCM open.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { connections } from './db/schema.js';
import type { LinkMethod } from './db/schema.js';
import { log } from './log.js';
import { SecretFailure, available, decrypt, encrypt } from './secrets.js';

/** Unix seconds. */
function now(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * How long before an access token's expiry it counts as expired.
 *
 * A token that expires in four seconds will expire mid-request. Treating it as already gone means
 * the refresh happens before the call rather than as a retry after a 401.
 */
const EXPIRY_MARGIN = 60;

/**
 * A linked account, as a page may see it.
 *
 * No token, no refresh token, not even an encrypted one. See the note at the top.
 */
export interface Connection {
	readonly id: string;
	readonly userId: string;
	readonly platform: string;
	readonly platformAccountId: string;
	readonly handle: string | null;
	readonly displayName: string | null;
	readonly avatarUrl: string | null;
	readonly method: LinkMethod;

	/** The scopes the platform actually granted. */
	readonly scopes: readonly string[];

	/** Whether this account is shown publicly as one of the creator's socials. */
	readonly shown: boolean;

	/** Unix seconds, or null where the credential does not expire. */
	readonly expiresAt: number | null;

	/** Whether the stored access token has expired, or is about to. */
	readonly expired: boolean;

	/** Whether there is a refresh token, so a caller knows whether expiry is recoverable. */
	readonly refreshable: boolean;

	readonly createdAt: number;
	readonly updatedAt: number;
}

/** What a provider needs to call a platform as this account. */
export interface Credential {
	readonly platform: string;
	readonly platformAccountId: string;
	readonly handle: string | null;
	readonly accessToken: string | null;
	readonly refreshToken: string | null;
	readonly expiresAt: number | null;
	readonly scopes: readonly string[];
}

/** What a caller supplies to record a link. */
export interface NewConnection {
	readonly userId: string;
	readonly platform: string;
	readonly platformAccountId: string;
	readonly handle?: string | null;
	readonly displayName?: string | null;
	readonly avatarUrl?: string | null;
	readonly method: LinkMethod;

	/** The raw token. Encrypted here; callers never encrypt for themselves. */
	readonly accessToken?: string | null;
	readonly refreshToken?: string | null;
	readonly expiresAt?: number | null;
	readonly scopes?: readonly string[];
}

/** Why a link was not stored. */
export type LinkRefusal =
	/** `SECRET_KEY` is not set, so a token cannot be stored encrypted. */
	| 'no_secret_key'
	/** Another account already holds this platform account. */
	| 'already_linked';

/** The row as the database holds it. */
interface Row {
	id: string;
	userId: string;
	platform: string;
	platformAccountId: string;
	handle: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	method: string;
	accessToken: string | null;
	refreshToken: string | null;
	expiresAt: number | null;
	scopes: string;
	shown: boolean;
	createdAt: number;
	updatedAt: number;
}

/** Every column, as one place so the selects cannot drift apart. */
const COLUMNS = {
	id: connections.id,
	userId: connections.userId,
	platform: connections.platform,
	platformAccountId: connections.platformAccountId,
	handle: connections.handle,
	displayName: connections.displayName,
	avatarUrl: connections.avatarUrl,
	method: connections.method,
	accessToken: connections.accessToken,
	refreshToken: connections.refreshToken,
	expiresAt: connections.expiresAt,
	scopes: connections.scopes,
	shown: connections.shown,
	createdAt: connections.createdAt,
	updatedAt: connections.updatedAt
} as const;

/**
 * A stored method, checked.
 *
 * The column is a typed string rather than a constraint, so a row holding something else resolves to
 * the least capable reading — `token`, which assumes no refresh flow — rather than being trusted.
 */
function methodOf(value: string): LinkMethod {
	if (value === 'oauth' || value === 'token' || value === 'login') return value;

	log().error({ method: value }, 'a connection holds a link method that does not exist');

	return 'token';
}

/** The scopes column as a list. Empty rather than `['']` for a row that granted none. */
function scopesOf(value: string): readonly string[] {
	return value.split(' ').filter((scope) => scope !== '');
}

/** A row as a page may see it. */
function toConnection(row: Row): Connection {
	return {
		id: row.id,
		userId: row.userId,
		platform: row.platform,
		platformAccountId: row.platformAccountId,
		handle: row.handle,
		displayName: row.displayName,
		avatarUrl: row.avatarUrl,
		method: methodOf(row.method),
		scopes: scopesOf(row.scopes),
		shown: row.shown,
		expiresAt: row.expiresAt,
		expired: row.expiresAt !== null && row.expiresAt - EXPIRY_MARGIN <= now(),
		refreshable: row.refreshToken !== null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** Everything a user has linked, most recently linked first. */
export function connectionsOf(userId: string): readonly Connection[] {
	return db()
		.select(COLUMNS)
		.from(connections)
		.where(eq(connections.userId, userId))
		.orderBy(desc(connections.createdAt))
		.all()
		.map(toConnection);
}

/**
 * The accounts shown publicly as the creator's socials.
 *
 * Read by the public page, which is why it is a query rather than a filter over
 * {@link connectionsOf}: the public page has no user to ask about, and must never see an account
 * nobody chose to show.
 */
export function shownConnections(): readonly Connection[] {
	return db()
		.select(COLUMNS)
		.from(connections)
		.where(eq(connections.shown, true))
		.orderBy(connections.platform)
		.all()
		.map(toConnection);
}

/**
 * The connection this installation uses for a platform, or null.
 *
 * The most recently linked one wins when there are several. A single-tenant site has one account per
 * platform in practice, and "the newest" is both the obvious reading of a re-link and the one a
 * creator fixing a broken token expects.
 */
export function connectionFor(platform: string): Connection | null {
	const [row] = db()
		.select(COLUMNS)
		.from(connections)
		.where(eq(connections.platform, platform))
		.orderBy(desc(connections.createdAt))
		.limit(1)
		.all();

	return row === undefined ? null : toConnection(row);
}

/**
 * The credential for a platform, decrypted, or null.
 *
 * The only function that returns a token. Null both for a platform nothing is linked for and for a
 * row whose secret cannot be read — a changed `SECRET_KEY`, a truncated column — because a provider
 * cannot act on the difference and the alternative is every provider catching the same error.
 * The failure is logged, which is where it is actually diagnosable.
 */
export function credentialFor(platform: string): Credential | null {
	const [row] = db()
		.select(COLUMNS)
		.from(connections)
		.where(eq(connections.platform, platform))
		.orderBy(desc(connections.createdAt))
		.limit(1)
		.all();

	if (row === undefined) return null;

	try {
		return {
			platform: row.platform,
			platformAccountId: row.platformAccountId,
			handle: row.handle,
			accessToken: row.accessToken === null ? null : decrypt(row.accessToken),
			refreshToken: row.refreshToken === null ? null : decrypt(row.refreshToken),
			expiresAt: row.expiresAt,
			scopes: scopesOf(row.scopes)
		};
	} catch (cause) {
		// Never the token, never the ciphertext. The platform and the reason are what a creator needs
		// to know, and they are enough to act on: re-link that account.
		log().error(
			{ platform, reason: cause instanceof SecretFailure ? cause.message : 'unknown' },
			'a linked account could not be decrypted; it has to be linked again'
		);

		return null;
	}
}

/**
 * Records a link, replacing an existing one for the same platform account.
 *
 * Replacing rather than refusing, for the *same* user: re-linking is how somebody fixes an expired
 * token or grants a scope they declined, and making them remove the old row first would be a step
 * with no purpose. A platform account another user holds is refused, because moving it is how one
 * person takes over another's integration.
 *
 * @returns the stored connection, or why it was not stored
 */
export function link(input: NewConnection): Connection | LinkRefusal {
	const carriesSecret = fieldSet(input.accessToken) || fieldSet(input.refreshToken);

	// Refused rather than stored in the clear. A database of plaintext credentials is not something a
	// later fix can undo.
	if (carriesSecret && !available()) return 'no_secret_key';

	const existing = db()
		.select({ id: connections.id, userId: connections.userId })
		.from(connections)
		.where(
			and(
				eq(connections.platform, input.platform),
				eq(connections.platformAccountId, input.platformAccountId)
			)
		)
		.all();

	const found = existing[0];

	if (found !== undefined && found.userId !== input.userId) return 'already_linked';

	const values = {
		userId: input.userId,
		platform: input.platform,
		platformAccountId: input.platformAccountId,
		handle: input.handle ?? null,
		displayName: input.displayName ?? null,
		avatarUrl: input.avatarUrl ?? null,
		method: input.method,
		accessToken: fieldSet(input.accessToken) ? encrypt(input.accessToken) : null,
		refreshToken: fieldSet(input.refreshToken) ? encrypt(input.refreshToken) : null,
		expiresAt: input.expiresAt ?? null,
		scopes: (input.scopes ?? []).join(' '),
		updatedAt: now()
	};

	if (found === undefined) {
		db()
			.insert(connections)
			.values({ id: randomUUID(), ...values })
			.run();
	} else {
		// `shown` is deliberately not in `values`: whether an account appears publicly is a decision the
		// creator made on the account page, and re-linking to fix a token should not silently undo it.
		db().update(connections).set(values).where(eq(connections.id, found.id)).run();
	}

	log().info({ platform: input.platform, method: input.method }, 'account linked');

	const stored = connectionFor(input.platform);

	// Unreachable: the row was just written. Reported rather than asserted, because a store that
	// cannot read back what it wrote is a different problem from a refused link.
	return stored ?? 'already_linked';
}

/** Whether an optional secret field was actually supplied. */
function fieldSet(value: string | null | undefined): value is string {
	return typeof value === 'string' && value !== '';
}

/**
 * Replaces a connection's tokens after a refresh.
 *
 * Separate from {@link link} because a refresh changes only the credential: the handle, the display
 * name and whether the account is shown are not the refresh endpoint's business, and a full link
 * would quietly overwrite them with whatever the caller happened to have.
 *
 * @returns whether a row was updated
 */
export function refreshCredential(
	id: string,
	tokens: {
		readonly accessToken: string;
		readonly refreshToken?: string | null;
		readonly expiresAt?: number | null;
		readonly scopes?: readonly string[];
	}
): boolean {
	if (!available()) return false;

	// A platform that rotates its refresh token sends a new one; one that does not sends nothing, and
	// the stored one must be kept rather than cleared.
	const refresh = fieldSet(tokens.refreshToken)
		? { refreshToken: encrypt(tokens.refreshToken) }
		: {};

	const scopes = tokens.scopes === undefined ? {} : { scopes: tokens.scopes.join(' ') };

	return (
		db()
			.update(connections)
			.set({
				accessToken: encrypt(tokens.accessToken),
				expiresAt: tokens.expiresAt ?? null,
				updatedAt: now(),
				...refresh,
				...scopes
			})
			.where(eq(connections.id, id))
			.run().changes > 0
	);
}

/** Shows or hides an account on the public page. Scoped to its owner. */
export function setShown(userId: string, id: string, shown: boolean): boolean {
	return (
		db()
			.update(connections)
			.set({ shown })
			.where(and(eq(connections.id, id), eq(connections.userId, userId)))
			.run().changes > 0
	);
}

/**
 * Removes a link.
 *
 * Scoped to its owner, so an id belonging to somebody else is not found rather than deleted — the id
 * arrives from a form, which means from outside the trust boundary whatever the page believes it
 * rendered.
 */
export function unlink(userId: string, id: string): boolean {
	return (
		db()
			.delete(connections)
			.where(and(eq(connections.id, id), eq(connections.userId, userId)))
			.run().changes > 0
	);
}
