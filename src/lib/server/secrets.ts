/**
 * Encrypting the secrets that have to be stored.
 *
 * A linked account's access token is a credential somebody else issued, and it ends up in a SQLite
 * file — which means it ends up in whatever backs that file up, in whatever snapshot the host takes,
 * and in the copy somebody made before an upgrade. Encrypting it at rest does not make the database
 * safe to lose; it makes losing the database not the same as losing every creator's platform access.
 *
 * ### AES-256-GCM, from `node:crypto`
 *
 * Authenticated encryption, so a modified ciphertext fails to decrypt rather than decrypting to
 * something else. No dependency: this is three calls to a module Node already has, and a library
 * here would be a supply-chain surface around `createCipheriv`.
 *
 * A fresh 12-byte nonce per encryption, stored alongside the ciphertext. Twelve bytes is what GCM is
 * specified for, and reusing one with the same key is the single mistake that breaks the mode
 * completely — so it is generated per call and never derived from anything.
 *
 * ### One key, from the environment
 *
 * `SECRET_KEY` is the one credential that stays an environment variable, because something has to
 * be: a key stored next to what it encrypts is decoration. Everything else moves into the database
 * behind it.
 *
 * Derived with scrypt rather than used raw, so the variable can be a passphrase a person chose
 * instead of 32 bytes of base64 they had to generate correctly. The salt is fixed and public —
 * stretching here is about turning an arbitrary-length secret into a key, not about surviving a
 * stolen database, which a per-record salt would not help with either since the key is in the
 * environment of the process that was reading it.
 *
 * ### What happens without a key
 *
 * {@link available} is false and {@link encrypt} throws. Nothing silently stores a token in the
 * clear, and nothing silently pretends a stored token is unreadable: a deployment with linked
 * accounts and no key gets a clear failure at the point of use, which is recoverable, rather than a
 * database of plaintext credentials, which is not.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { SECRET_KEY } from '$app/env/private';

/** AES-256-GCM. The only algorithm this module has ever used; see the note above. */
const ALGORITHM = 'aes-256-gcm';

/** Bytes of key material AES-256 takes. */
const KEY_BYTES = 32;

/** Bytes of nonce. Twelve is what GCM is specified for. */
const NONCE_BYTES = 12;

/** Bytes of authentication tag. Sixteen is the full tag; a truncated one weakens the guarantee. */
const TAG_BYTES = 16;

/**
 * The scrypt salt.
 *
 * Fixed and in the source on purpose. Stretching here turns a passphrase of any length into a key;
 * it is not a defence against a stolen database, because the key lives in the environment of the
 * process that reads it. A per-deployment salt would have to be stored somewhere, and the only place
 * to store it is next to the ciphertext, which buys nothing.
 */
const SALT = 'creator-site/secrets/v1';

/** scrypt cost. Node's default `N`; the derivation happens once per process, not per record. */
const COST = 16_384;

/** How a stored value is tagged, so a future format can be told apart from this one. */
const PREFIX = 'v1';

/** The derived key, computed once. */
let key: Buffer | null = null;

/** A value that could not be encrypted or decrypted. */
export class SecretFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SecretFailure';
	}
}

/** Whether this deployment can store secrets at all. */
export function available(): boolean {
	return SECRET_KEY !== undefined && SECRET_KEY !== '';
}

/**
 * The key, derived on first use.
 *
 * Once per process rather than per record: scrypt at this cost takes tens of milliseconds, which is
 * the right price for a start-up and the wrong one for every row of a list.
 */
function keyMaterial(): Buffer {
	if (SECRET_KEY === undefined || SECRET_KEY === '') {
		throw new SecretFailure('SECRET_KEY is not set, so secrets cannot be stored or read.');
	}

	key ??= scryptSync(SECRET_KEY, SALT, KEY_BYTES, { N: COST });

	return key;
}

/**
 * Encrypts a value for storage.
 *
 * @returns `v1.<nonce>.<tag>.<ciphertext>`, all base64url. One string, because the thing storing it
 *          is a text column and a format with three columns is three ways for them to disagree.
 */
export function encrypt(value: string): string {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(ALGORITHM, keyMaterial(), nonce);
	const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return [PREFIX, nonce, tag, body]
		.map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
		.join('.');
}

/**
 * Reads a stored value back.
 *
 * Throws {@link SecretFailure} for anything that is not a value this module wrote with this key —
 * a truncated column, a different key, a tampered ciphertext. Throwing rather than returning null
 * because a caller that treats "cannot read" as "not set" would silently re-link an account that is
 * perfectly fine, and because a failing authentication tag is worth knowing about.
 */
export function decrypt(stored: string): string {
	const parts = stored.split('.');
	const [prefix, nonce, tag, body] = parts;

	if (parts.length !== 4 || prefix !== PREFIX || nonce === undefined || tag === undefined) {
		throw new SecretFailure('That stored secret is not in a format this version can read.');
	}

	const nonceBytes = Buffer.from(nonce, 'base64url');
	const tagBytes = Buffer.from(tag, 'base64url');

	if (nonceBytes.length !== NONCE_BYTES || tagBytes.length !== TAG_BYTES) {
		throw new SecretFailure('That stored secret is malformed.');
	}

	try {
		const decipher = createDecipheriv(ALGORITHM, keyMaterial(), nonceBytes);
		decipher.setAuthTag(tagBytes);

		return Buffer.concat([
			decipher.update(Buffer.from(body ?? '', 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch (cause) {
		if (cause instanceof SecretFailure) throw cause;

		// Never the underlying message: an OpenSSL error here says nothing a caller can act on, and
		// the one thing it could leak is which part of the format failed.
		throw new SecretFailure('That stored secret could not be read with this key.');
	}
}

/** Forgets the derived key. For tests, which change `SECRET_KEY` between them. */
export function forgetKey(): void {
	key = null;
}
