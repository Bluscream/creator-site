/**
 * Which sign-in providers an install offers.
 *
 * Short, and it covers the property that matters most: an unconfigured provider is not offered and
 * is not distinguishable from one this build does not have. A route that answered differently for
 * "not implemented" and "implemented but no credentials" would let anyone enumerate what a site is
 * part-way through setting up.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * The credentials the provider reads.
 *
 * Explicitly `| undefined` rather than optional: `exactOptionalPropertyTypes` distinguishes "absent"
 * from "present and undefined", and a test that unsets one is doing the second.
 */
const env = vi.hoisted(() => {
	const state: { id: string | undefined; secret: string | undefined } = {
		id: 'client-id',
		secret: 'client-secret'
	};

	return state;
});

vi.mock('$app/env/private', () => ({
	get DISCORD_CLIENT_ID() {
		return env.id;
	},
	get DISCORD_CLIENT_SECRET() {
		return env.secret;
	}
}));

const { signInConfigured, signInProvider, signInProviders } = await import('./sign-in-registry.js');

/** Puts the environment back for the next test, whichever one changed it. */
function configured(id: string | undefined, secret: string | undefined): void {
	env.id = id;
	env.secret = secret;
}

describe('signInProviders', () => {
	it('offers Discord when it is configured', () => {
		configured('client-id', 'client-secret');

		expect(signInProviders().map((provider) => provider.kind)).toStrictEqual(['discord']);
	});

	it('offers nothing on a bare install', () => {
		configured(undefined, undefined);

		expect(signInProviders()).toStrictEqual([]);
	});

	it('offers nothing when only half of a provider is configured', () => {
		configured('client-id', undefined);

		expect(signInProviders()).toStrictEqual([]);
	});

	it('gives every provider a label to put on a button', () => {
		configured('client-id', 'client-secret');

		for (const provider of signInProviders()) expect(provider.label).not.toBe('');
	});
});

describe('signInProvider', () => {
	it('finds a configured provider by kind', () => {
		configured('client-id', 'client-secret');

		expect(signInProvider('discord')?.kind).toBe('discord');
	});

	it('is null for a kind nobody implements', () => {
		configured('client-id', 'client-secret');

		expect(signInProvider('myspace')).toBeNull();
	});

	it('is null for a provider that is implemented but not configured', () => {
		// The same answer as for one that does not exist, deliberately. A visitor cannot act on the
		// difference, and collapsing them means a probe cannot enumerate a half-configured install.
		configured(undefined, undefined);

		expect(signInProvider('discord')).toBeNull();
	});

	it('is null for the empty string', () => {
		configured('client-id', 'client-secret');

		expect(signInProvider('')).toBeNull();
	});
});

describe('signInConfigured', () => {
	it('is true when something is', () => {
		configured('client-id', 'client-secret');

		expect(signInConfigured()).toBe(true);
	});

	it('is false on a bare install', () => {
		configured(undefined, undefined);

		expect(signInConfigured()).toBe(false);
	});
});
