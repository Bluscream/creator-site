/**
 * The provider selection rules.
 *
 * Tested against providers that do not exist, which is the only honest way to check "prefers the
 * configured one over a merely usable one" while there is a single real implementation. That is
 * also the point of the seam: the rules are about capabilities and credentials, never about which
 * service it happens to be.
 */

import { describe, expect, it } from 'vitest';
import { ServiceFailure } from '#lib/server/failure.js';
import { selectProvider } from '#lib/server/providers/registry.js';
import type { CredentialLookup } from '#lib/server/providers/registry.js';
import type { Credential } from '#lib/server/providers/credentials.js';
import type { Capability, ProviderFactory } from '#lib/server/providers/types.js';

/** A stand-in provider. Its `create` returns its own id, so a test can see which one was chosen. */
function stub(id: string, capabilities: readonly Capability[] = ['live']): ProviderFactory<string> {
	return {
		descriptor: { id, name: id, capabilities },
		usable: (credential) => credential.token !== undefined,
		create: () => id
	};
}

/** Credentials for the named providers and nothing else. */
function configured(...ids: readonly string[]): CredentialLookup {
	return (providerId): Credential => (ids.includes(providerId) ? { token: 'present' } : {});
}

const SYNCHRA = stub('synchra', ['live', 'chat', 'activity']);
const RESTREAM = stub('restream', ['live', 'chat']);
const OWNCAST = stub('owncast', ['live']);
const ALL = [SYNCHRA, RESTREAM, OWNCAST] as const;

describe('with nothing configured', () => {
	it('refuses with not_configured rather than returning nothing', () => {
		// Every caller would otherwise have to turn a null into exactly this refusal, and one of
		// them eventually would not.
		expect(() => selectProvider(ALL, configured())).toThrow(ServiceFailure);
		expect(() => selectProvider(ALL, configured())).toThrow('not_configured');
	});

	it('refuses when the list itself is empty', () => {
		expect(() => selectProvider([], configured('synchra'))).toThrow('not_configured');
	});
});

describe('with no preference', () => {
	it('takes the first usable one, so the order is the preference', () => {
		expect(selectProvider(ALL, configured('synchra', 'owncast')).descriptor.id).toBe('synchra');
	});

	it('skips an earlier provider that has no credentials', () => {
		expect(selectProvider(ALL, configured('owncast')).descriptor.id).toBe('owncast');
	});

	it('does not care which capabilities beyond the asked-for one it has', () => {
		// Owncast can answer "am I live" and nothing else, and that is enough to be the live
		// provider. This is why the interfaces are per capability.
		const chosen = selectProvider([OWNCAST], configured('owncast'));

		expect(chosen.descriptor.capabilities).toStrictEqual(['live']);
	});
});

describe('with a configured preference', () => {
	it('uses it even when an earlier one would also work', () => {
		// An operator who picked Restream meant Restream; silently preferring Synchra because it is
		// first would be impossible to debug from the outside.
		expect(selectProvider(ALL, configured('synchra', 'restream'), 'restream').descriptor.id).toBe(
			'restream'
		);
	});

	it('refuses rather than falling back when the preferred one has no credentials', () => {
		// A fallback here is a silent disagreement with what was asked for.
		expect(() => selectProvider(ALL, configured('synchra'), 'restream')).toThrow('not_configured');
	});

	it('refuses when it names a provider that is not installed', () => {
		expect(() => selectProvider(ALL, configured('synchra'), 'myspace')).toThrow('not_configured');
	});
});

describe('what a chosen factory produces', () => {
	it('is built from the credentials the lookup gave for that provider', () => {
		const seen: Credential[] = [];
		const recording: ProviderFactory<string> = {
			descriptor: { id: 'recording', name: 'Recording', capabilities: ['live'] },
			usable: () => true,
			create: (credential) => {
				seen.push(credential);

				return 'recording';
			}
		};

		const factory = selectProvider([recording], () => ({ token: 'tok', channelId: 'chan' }));

		expect(factory.create({ token: 'tok', channelId: 'chan' })).toBe('recording');
		expect(seen).toStrictEqual([{ token: 'tok', channelId: 'chan' }]);
	});

	it('is never asked to be usable by making a network call', () => {
		// `usable` answers "are the credentials present and well-formed", not "do they work". The
		// registry calls it for every provider on every resolution, so a request in there would be a
		// request per page view per provider.
		let called = 0;
		const counting: ProviderFactory<string> = {
			descriptor: { id: 'counting', name: 'Counting', capabilities: ['live'] },
			usable: () => {
				called += 1;

				return true;
			},
			create: () => 'counting'
		};

		selectProvider([counting], configured('counting'));

		expect(called).toBe(1);
	});
});
