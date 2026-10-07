/**
 * That a stored secret round-trips, and that nothing else does.
 *
 * The round trip is the easy half. The half worth the tests is everything that must *fail*: a
 * ciphertext somebody edited, one encrypted under a different key, one truncated by a column that
 * was too narrow. Authenticated encryption is only worth having if the authentication is actually
 * checked, and "it decrypted to something" is how that check gets quietly removed.
 */

import { describe, expect, it, vi } from 'vitest';

/** `SECRET_KEY`, which several of these change. */
const env = vi.hoisted(() => {
	const state: { key: string | undefined } = { key: 'a-test-passphrase-at-least-16' };

	return state;
});

vi.mock('$app/env/private', () => ({
	get SECRET_KEY() {
		return env.key;
	}
}));

const { SecretFailure, available, decrypt, encrypt, forgetKey } = await import('./secrets.js');

/** Sets the key and forgets the derived one, which is cached per process. */
function withKey(value: string | undefined): void {
	env.key = value;
	forgetKey();
}

describe('available', () => {
	it('is true with a key', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(available()).toBe(true);
	});

	it('is false with none', () => {
		withKey(undefined);

		expect(available()).toBe(false);
	});

	it('is false for an empty key, which is what an empty env line leaves', () => {
		withKey('');

		expect(available()).toBe(false);
	});
});

describe('encrypt and decrypt', () => {
	it('round-trips a value', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(decrypt(encrypt('an-access-token'))).toBe('an-access-token');
	});

	it('round-trips an empty string', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(decrypt(encrypt(''))).toBe('');
	});

	it('round-trips text outside ASCII', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(decrypt(encrypt('a token with ümlauts and 😀'))).toBe('a token with ümlauts and 😀');
	});

	it('round-trips something long', () => {
		withKey('a-test-passphrase-at-least-16');

		const value = 'x'.repeat(10_000);

		expect(decrypt(encrypt(value))).toBe(value);
	});

	it('does not contain the plaintext', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(encrypt('an-access-token')).not.toContain('an-access-token');
	});

	it('produces a different ciphertext every time', () => {
		// A fresh nonce per call. Reusing one with the same key is the single mistake that breaks GCM
		// completely, and identical output for identical input is what it would look like.
		withKey('a-test-passphrase-at-least-16');

		const seen = new Set(Array.from({ length: 20 }, () => encrypt('the-same-token')));

		expect(seen.size).toBe(20);
	});

	it('carries a version so a later format can be told apart', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(encrypt('x').startsWith('v1.')).toBe(true);
	});
});

describe('what must not decrypt', () => {
	it('refuses a tampered ciphertext', () => {
		// The whole reason for an authenticated mode. Without the tag check this would decrypt to
		// something, and a caller would use it.
		withKey('a-test-passphrase-at-least-16');

		const [prefix, nonce, tag, body] = encrypt('an-access-token').split('.');
		const flipped = Buffer.from(body ?? '', 'base64url');

		// `noUncheckedIndexedAccess` is right to ask: a zero-length body would have no byte 0. An
		// encryption of a non-empty value always does.
		flipped[0] = (flipped[0] ?? 0) ^ 0xff;

		expect(() => decrypt([prefix, nonce, tag, flipped.toString('base64url')].join('.'))).toThrow(
			SecretFailure
		);
	});

	it('refuses a tampered tag', () => {
		withKey('a-test-passphrase-at-least-16');

		const [prefix, nonce, tag, body] = encrypt('an-access-token').split('.');
		const flipped = Buffer.from(tag ?? '', 'base64url');

		flipped[0] = (flipped[0] ?? 0) ^ 0xff;

		expect(() => decrypt([prefix, nonce, flipped.toString('base64url'), body].join('.'))).toThrow(
			SecretFailure
		);
	});

	it('refuses a swapped nonce', () => {
		withKey('a-test-passphrase-at-least-16');

		const mine = encrypt('an-access-token').split('.');
		const theirs = encrypt('another-token').split('.');

		expect(() => decrypt([mine[0], theirs[1], mine[2], mine[3]].join('.'))).toThrow(SecretFailure);
	});

	it('refuses a value encrypted under a different key', () => {
		// What a changed `SECRET_KEY` looks like. It has to be a clear failure, not a wrong value.
		withKey('a-test-passphrase-at-least-16');
		const stored = encrypt('an-access-token');

		withKey('a-completely-different-passphrase');

		expect(() => decrypt(stored)).toThrow(SecretFailure);
	});

	it('refuses a truncated value', () => {
		withKey('a-test-passphrase-at-least-16');

		const stored = encrypt('an-access-token');

		expect(() => decrypt(stored.slice(0, stored.length - 4))).toThrow(SecretFailure);
	});

	it('refuses something that is not this format at all', () => {
		withKey('a-test-passphrase-at-least-16');

		expect(() => decrypt('an-access-token')).toThrow(SecretFailure);
	});

	it('refuses a value claiming a version this build does not have', () => {
		withKey('a-test-passphrase-at-least-16');

		const [, nonce, tag, body] = encrypt('an-access-token').split('.');

		expect(() => decrypt(['v2', nonce, tag, body].join('.'))).toThrow(SecretFailure);
	});

	it('refuses a nonce of the wrong length', () => {
		withKey('a-test-passphrase-at-least-16');

		const [prefix, , tag, body] = encrypt('an-access-token').split('.');

		expect(() =>
			decrypt([prefix, Buffer.alloc(8).toString('base64url'), tag, body].join('.'))
		).toThrow(/malformed/);
	});

	it('never repeats the underlying crypto error', () => {
		// An OpenSSL message says nothing a caller can act on, and the one thing it could leak is
		// which part of the format failed.
		withKey('a-test-passphrase-at-least-16');
		const stored = encrypt('an-access-token');
		withKey('a-completely-different-passphrase');

		try {
			decrypt(stored);
			expect.unreachable();
		} catch (cause) {
			expect((cause as Error).message).toBe('That stored secret could not be read with this key.');
		}
	});
});

describe('without a key', () => {
	it('refuses to encrypt rather than storing plaintext', () => {
		// A database of plaintext credentials is not recoverable; a clear failure at the point of use
		// is.
		withKey(undefined);

		expect(() => encrypt('an-access-token')).toThrow(SecretFailure);
	});

	it('refuses to decrypt', () => {
		withKey(undefined);

		expect(() => decrypt('v1.aaaa.bbbb.cccc')).toThrow(SecretFailure);
	});

	it('says which setting is missing, because that is actionable', () => {
		withKey(undefined);

		expect(() => encrypt('x')).toThrow(/SECRET_KEY/);
	});
});

describe('the key is a passphrase, not raw bytes', () => {
	it('accepts something a person chose', () => {
		withKey('correct horse battery staple');

		expect(decrypt(encrypt('x'))).toBe('x');
	});

	it('accepts generated base64', () => {
		withKey(Buffer.alloc(32, 7).toString('base64'));

		expect(decrypt(encrypt('x'))).toBe('x');
	});

	it('derives the same key twice, so a restart can read what it wrote', () => {
		withKey('a-test-passphrase-at-least-16');
		const stored = encrypt('an-access-token');

		// A new process with the same environment.
		forgetKey();

		expect(decrypt(stored)).toBe('an-access-token');
	});
});
