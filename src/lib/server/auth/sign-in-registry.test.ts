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
	const state: {
		id: string | undefined;
		secret: string | undefined;
		twitchId: string | undefined;
		twitchSecret: string | undefined;
		youtubeId: string | undefined;
		youtubeSecret: string | undefined;
	} = {
		id: 'client-id',
		secret: 'client-secret',
		twitchId: undefined,
		twitchSecret: undefined,
		youtubeId: undefined,
		youtubeSecret: undefined
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
	},

	// Left undefined rather than omitted. An omitted export is a module-load error — "no
	// KICK_CLIENT_ID export is defined on the mock" — which is what adding Kick produced here, and
	// it reads like a bug in the mock rather than what it is: a new platform this file has not
	// decided what to do about. Undefined is the decision, and it means "not configured".
	get KICK_CLIENT_ID() {
		return undefined;
	},
	get KICK_CLIENT_SECRET() {
		return undefined;
	},

	// Controllable, because YouTube is the platform that can be linked and cannot sign anybody in —
	// which is the whole subject of the last block in this file.
	get YOUTUBE_CLIENT_ID() {
		return env.youtubeId;
	},
	get YOUTUBE_CLIENT_SECRET() {
		return env.youtubeSecret;
	}
}));

const { linkProvider, signInConfigured, signInProvider, signInProviders } =
	await import('./sign-in-registry.js');

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

describe('a platform that can be linked but cannot sign anybody in', () => {
	/**
	 * The failure this block exists for.
	 *
	 * `platform.ts` says capabilities and methods are independent lists, and the account page relies
	 * on it — but both auth routes resolved their provider through {@link signInProvider}, which
	 * filters by the `sign-in` capability. A platform that can be linked and cannot sign anybody in
	 * was therefore offered by the account page and answered 404 by the route.
	 *
	 * It was found by mutation: making {@link linkProvider} delegate to {@link signInProvider} broke
	 * nothing, which meant nothing checked the one thing it was added for.
	 */
	function withYouTube(body: () => void): void {
		env.youtubeId = 'youtube-client-id';
		env.youtubeSecret = 'youtube-client-secret';

		try {
			body();
		} finally {
			env.youtubeId = undefined;
			env.youtubeSecret = undefined;
		}
	}

	it('is reachable for a link', () => {
		withYouTube(() => {
			expect(linkProvider('youtube')?.kind).toBe('youtube');
		});
	});

	it('is not offered as a way of signing in', () => {
		// The other half. A permissive link lookup would be a hole if this were not also true.
		withYouTube(() => {
			expect(signInProvider('youtube')).toBeNull();
			expect(signInProviders().map((provider) => provider.kind)).not.toContain('youtube');
		});
	});

	it('is not reachable for a link when it is not configured', () => {
		expect(linkProvider('youtube')).toBeNull();
	});

	it('is null for a platform nobody implements', () => {
		expect(linkProvider('myspace')).toBeNull();
	});

	it('still resolves a platform that can do both', () => {
		// A link lookup must not have become a lookup for *only* link-only platforms. Discord is set
		// here rather than relied on from this file's defaults, which earlier tests unset.
		env.id = 'client-id';
		env.secret = 'client-secret';

		expect(linkProvider('discord')?.kind).toBe('discord');
	});
});
