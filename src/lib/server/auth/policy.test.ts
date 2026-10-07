/**
 * The bootstrap list and the registration switch.
 *
 * Small, and worth testing anyway: the floor is what lets a creator back into their own site after
 * they have demoted themselves, and the thing most likely to break it is a parsing rule — an entry
 * matched case-sensitively, a provider prefix dropped, a bare id treated as a wildcard. Each of
 * those would fail silently, as "the environment says you are an admin and the site disagrees".
 */

import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
	accounts: [] as string[],
	registration: false
}));

vi.mock('$app/env/private', () => ({
	get ADMIN_ACCOUNTS() {
		return env.accounts;
	},
	get ALLOW_REGISTRATION() {
		return env.registration;
	}
}));

const { isNamedAdmin, namedAdmins, registrationPolicy, roleFloorFor } = await import('./policy.js');

/** An identity as a provider would hand one over. */
function identity(provider: string, providerUserId: string) {
	return { provider, providerUserId };
}

describe('registrationPolicy', () => {
	it('is off when the environment says nothing', () => {
		env.registration = false;

		expect(registrationPolicy()).toStrictEqual({ register: false });
	});

	it('is on when it says so', () => {
		env.registration = true;

		expect(registrationPolicy()).toStrictEqual({ register: true });
	});
});

describe('isNamedAdmin', () => {
	it('is false when nobody is named', () => {
		env.accounts = [];

		expect(isNamedAdmin(identity('discord', '1'))).toBe(false);
	});

	it('matches a named account', () => {
		env.accounts = ['discord:1'];

		expect(isNamedAdmin(identity('discord', '1'))).toBe(true);
	});

	it('does not match the same id on another provider', () => {
		// The entry names a person at a provider, not a number. Matching on the id alone would hand
		// the admin to whoever happened to have that id somewhere else.
		env.accounts = ['discord:1'];

		expect(isNamedAdmin(identity('google', '1'))).toBe(false);
	});

	it('does not match a different id on the named provider', () => {
		env.accounts = ['discord:1'];

		expect(isNamedAdmin(identity('discord', '12'))).toBe(false);
	});

	it('does not treat an entry as a prefix', () => {
		env.accounts = ['discord:1'];

		expect(isNamedAdmin(identity('discord', '1000'))).toBe(false);
	});

	it('picks any one of several names', () => {
		env.accounts = ['discord:1', 'google:9'];

		expect(isNamedAdmin(identity('google', '9'))).toBe(true);
	});
});

describe('roleFloorFor', () => {
	it('is null for somebody nobody named', () => {
		// Null rather than `member`: the environment says who *must* be able to administer the site,
		// not what everyone else gets.
		env.accounts = [];

		expect(roleFloorFor(identity('discord', '1'))).toBeNull();
	});

	it('is admin for a named account', () => {
		env.accounts = ['discord:1'];

		expect(roleFloorFor(identity('discord', '1'))).toBe('admin');
	});

	it('is never the owner, which belongs to the install rather than to a setting', () => {
		env.accounts = ['discord:1'];

		expect(roleFloorFor(identity('discord', '1'))).not.toBe('owner');
	});
});

describe('namedAdmins', () => {
	it('counts what is configured', () => {
		env.accounts = ['discord:1', 'google:9'];

		expect(namedAdmins()).toBe(2);
	});

	it('is zero when nothing is', () => {
		env.accounts = [];

		expect(namedAdmins()).toBe(0);
	});
});
