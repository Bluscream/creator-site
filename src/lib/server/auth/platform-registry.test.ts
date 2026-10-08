/**
 * The platform seam, and the invariants that keep one id meaning one thing.
 *
 * Most of this file checks properties *of the registry* rather than of any one platform, because the
 * failures worth catching here are the ones that arrive with the second entry: an id that is not a
 * key of the icon registry, a method declared but with no implementation behind it, a capability
 * list that is empty. Each of those renders as something subtly wrong — a missing icon, a button
 * that 404s, a platform offered for nothing — a long way from the line that caused it.
 */

import { describe, expect, it, vi } from 'vitest';
import { hasPlatform } from '#lib/platforms.js';
import { LINK_METHODS } from '#lib/server/db/schema.js';
import type { AccountPlatform } from './platform.js';

/** The credentials the Discord half reads. See `sign-in-registry.test.ts` for the shape. */
const env = vi.hoisted(() => {
	const state: {
		id: string | undefined;
		secret: string | undefined;
		twitchId: string | undefined;
		twitchSecret: string | undefined;
	} = {
		id: 'client-id',
		secret: 'client-secret',
		twitchId: undefined,
		twitchSecret: undefined
	};

	return state;
});

vi.mock('$app/env/private', () => ({
	get DISCORD_CLIENT_ID() {
		return env.id;
	},
	get DISCORD_CLIENT_SECRET() {
		return env.secret;
	},

	// Mocked, not read. A developer with real Twitch credentials in their environment would
	// otherwise have a second platform appear in these assertions on their machine and not in CI.
	get TWITCH_CLIENT_ID() {
		return env.twitchId;
	},
	get TWITCH_CLIENT_SECRET() {
		return env.twitchSecret;
	}
}));

const { accountPlatform, accountPlatforms, linkablePlatforms, platformsFor } =
	await import('./platform-registry.js');
const { CAPABILITIES, linkable, offeredMethods, supports } = await import('./platform.js');
const { signInProviders } = await import('./sign-in-registry.js');

/**
 * The first registered platform, as a value rather than a possibly-undefined index.
 *
 * `noUncheckedIndexedAccess` makes `[0]` optional and a non-null assertion is forbidden, which is
 * right: a test that asserted past an empty registry would report the wrong failure.
 */
function firstPlatform(): AccountPlatform {
	const [entry] = accountPlatforms();

	if (entry === undefined) throw new Error('no platform is registered');

	return entry;
}

/** One platform by id, or a failure naming the id rather than a null dereference. */
function platformNamed(id: string): AccountPlatform {
	const entry = accountPlatform(id);

	if (entry === null) throw new Error(`${id} is not linkable`);

	return entry;
}

/** Puts the environment back, whichever test changed it. */
function configured(id: string | undefined, secret: string | undefined): void {
	env.id = id;
	env.secret = secret;
}

describe('every registered platform', () => {
	it('has an id the icon registry knows', () => {
		// The id is `connections.platform`, the URL segment *and* a key of `src/lib/platforms.ts`,
		// which is where the icon, the name and the brand colour live. A mismatch draws a linked
		// account with the generic link icon and nobody notices until they look at the page.
		for (const entry of accountPlatforms()) {
			expect(hasPlatform(entry.id), `${entry.id} is not in the platform registry`).toBe(true);
		}
	});

	it('has a unique id', () => {
		const ids = accountPlatforms().map((entry) => entry.id);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it('is good for something', () => {
		for (const entry of accountPlatforms()) {
			expect(entry.capabilities.length, `${entry.id} declares no capability`).toBeGreaterThan(0);
		}
	});

	it('declares only capabilities that exist', () => {
		for (const entry of accountPlatforms()) {
			for (const capability of entry.capabilities) {
				expect(CAPABILITIES).toContain(capability);
			}
		}
	});

	it('declares only link methods that exist', () => {
		for (const entry of accountPlatforms()) {
			for (const method of entry.methods) {
				expect(LINK_METHODS).toContain(method);
			}
		}
	});

	it('has an implementation behind every method it declares', () => {
		// The failure this catches: a platform that lists `token` with nothing to verify it renders a
		// paste field that cannot do anything, and the person finds out after pasting a credential.
		for (const entry of accountPlatforms()) {
			if (entry.methods.includes('oauth')) {
				expect(entry.oauth, `${entry.id} offers oauth with no provider`).not.toBeNull();
			}

			if (entry.methods.includes('token')) {
				expect(entry.token, `${entry.id} offers token with no verifier`).not.toBeNull();
			}
		}
	});

	it('declares a method for every implementation it carries', () => {
		// The other direction, which is the quieter bug: an implementation nothing offers is dead
		// code that still looks maintained.
		for (const entry of accountPlatforms()) {
			if (entry.oauth !== null) expect(entry.methods).toContain('oauth');
			if (entry.token !== null) expect(entry.methods).toContain('token');
		}
	});

	it('offers oauth before anything else it supports', () => {
		// The order is the order the account page renders, and OAuth is the only method where the
		// secret never passes through a form.
		for (const entry of accountPlatforms()) {
			if (!entry.methods.includes('oauth')) continue;

			expect(entry.methods[0], `${entry.id} offers oauth second`).toBe('oauth');
		}
	});

	it('can sign somebody in only if it can be linked by oauth', () => {
		for (const entry of accountPlatforms()) {
			if (!supports(entry, 'sign-in')) continue;

			expect(entry.oauth, `${entry.id} claims sign-in with no oauth`).not.toBeNull();
		}
	});
});

describe('an installation that has configured nothing', () => {
	it('offers no platform at all', () => {
		configured(undefined, undefined);

		try {
			expect(linkablePlatforms()).toEqual([]);
			expect(accountPlatform('discord')).toBeNull();
		} finally {
			configured('client-id', 'client-secret');
		}
	});

	it('still knows which platforms this build supports', () => {
		// The registry is built once and does not consult the environment, which is what makes a
		// configured install and a bare one indistinguishable from outside.
		configured(undefined, undefined);

		try {
			expect(accountPlatforms().length).toBeGreaterThan(0);
			expect(offeredMethods(firstPlatform())).toEqual([]);
		} finally {
			configured('client-id', 'client-secret');
		}
	});
});

describe('a configured installation', () => {
	it('offers Discord for signing in and as a social link', () => {
		const discord = platformNamed('discord');

		expect(supports(discord, 'sign-in')).toBe(true);
		expect(supports(discord, 'social')).toBe(true);
	});

	it('does not claim Discord can read chat', () => {
		// Chat needs a bot in a guild, which is a different credential with a different blast radius.
		// Claiming it here is how somebody's personal link quietly becomes a bot token.
		expect(supports(platformNamed('discord'), 'chat')).toBe(false);
	});

	it('offers Discord by oauth only', () => {
		expect(offeredMethods(platformNamed('discord'))).toEqual(['oauth']);
	});

	it('answers with nothing for a platform nobody implements', () => {
		expect(accountPlatform('myspace')).toBeNull();
	});

	it('finds the platforms that could serve a capability', () => {
		expect(platformsFor('sign-in').map((entry) => entry.id)).toEqual(['discord']);
		expect(platformsFor('chat')).toEqual([]);
	});
});

describe('the sign-in list, which is derived from this one', () => {
	it('is exactly the platforms that declare sign-in', () => {
		// The invariant the derivation exists for: two hand-maintained arrays drifted apart, and a
		// platform that was linkable but not sign-in-able had nothing to notice it.
		expect(signInProviders().map((provider) => provider.kind)).toEqual(
			platformsFor('sign-in').map((entry) => entry.id)
		);
	});

	it('empties when the platform list does', () => {
		configured(undefined, undefined);

		try {
			expect(signInProviders()).toEqual([]);
		} finally {
			configured('client-id', 'client-secret');
		}
	});
});

describe('a second configured platform', () => {
	/** Twitch configured as well as Discord, put back afterwards. */
	function withTwitch(body: () => void): void {
		env.twitchId = 'twitch-client-id';
		env.twitchSecret = 'twitch-client-secret';

		try {
			body();
		} finally {
			env.twitchId = undefined;
			env.twitchSecret = undefined;
		}
	}

	it('appears only once it is configured', () => {
		expect(accountPlatform('twitch')).toBeNull();

		withTwitch(() => {
			expect(accountPlatform('twitch')).not.toBeNull();
		});
	});

	it('offers both of its methods, oauth first', () => {
		withTwitch(() => {
			expect(offeredMethods(platformNamed('twitch'))).toEqual(['oauth', 'token']);
		});
	});

	it('carries a verifier and a hint for the paste field', () => {
		withTwitch(() => {
			const twitch = platformNamed('twitch');

			expect(twitch.token).not.toBeNull();
			expect(twitch.token?.hint).toMatch(/token/i);
		});
	});

	it('does not claim chat, which nothing here reads yet', () => {
		// Claiming it would put a capability on the account page that leads nowhere, and would mean
		// asking the creator to approve a scope nothing uses.
		withTwitch(() => {
			expect(supports(platformNamed('twitch'), 'chat')).toBe(false);
		});
	});

	it('joins the sign-in list without being added to a second array', () => {
		// The payoff for deriving one list from the other: registering the platform was the whole
		// change, and signing in with it followed.
		withTwitch(() => {
			expect(signInProviders().map((provider) => provider.kind)).toEqual(['discord', 'twitch']);
		});
	});

	it('is offered for the capabilities it declares, beside the other platform', () => {
		withTwitch(() => {
			expect(platformsFor('social').map((entry) => entry.id)).toEqual(['discord', 'twitch']);
			expect(platformsFor('posts').map((entry) => entry.id)).toEqual(['twitch']);
		});
	});
});

describe('linkable', () => {
	it('is false for a platform whose every method is unconfigured', () => {
		configured(undefined, undefined);

		try {
			expect(linkable(firstPlatform())).toBe(false);
		} finally {
			configured('client-id', 'client-secret');
		}
	});
});
