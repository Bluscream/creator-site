/**
 * Which provider answers which capability.
 *
 * Deliberately a plain array and a first-usable-wins rule. There is no dynamic loading, no
 * container and no plugin discovery, because there is exactly one implementation today and
 * machinery built for a second one that does not exist yet is machinery nobody can check. What the
 * registry does guarantee is the **seam**: adding Restream means adding a factory to one array, and
 * nothing outside this directory changes.
 *
 * ### How a provider is chosen
 *
 * 1. If configuration names one, use it — even if another would also work. An operator who picked
 *    Twitch meant Twitch, and silently preferring something else would be impossible to debug.
 * 2. Otherwise the first registered factory whose credentials are present.
 * 3. Otherwise `not_configured`, which the page already renders as "not set up yet".
 *
 * Step 2 makes the order in {@link LIVE_PROVIDERS} a preference list, so it is ordered
 * most-capable-first rather than alphabetically.
 */

import { ServiceFailure, notConfigured } from '#lib/server/failure.js';
import { credentialsFor } from '#lib/server/providers/credentials.js';
import type { Credential } from '#lib/server/providers/credentials.js';
import { synchraLive } from '#lib/server/providers/synchra.js';
import type {
	Capability,
	LiveProvider,
	ProviderDescriptor,
	ProviderFactory
} from '#lib/server/providers/types.js';

/**
 * Providers that can answer live status, most capable first.
 *
 * Order is the default preference. Synchra is first because it covers all three capabilities, so a
 * deployment that has it should not end up reading live status from somewhere else.
 */
const LIVE_PROVIDERS: readonly ProviderFactory<LiveProvider>[] = [synchraLive];

/** Built providers, so a client with connection state is not rebuilt per request. */
const built = new Map<string, unknown>();

/** How the selection finds credentials. Injected so the rules can be tested without an env. */
export type CredentialLookup = (providerId: string) => Credential;

/**
 * Picks a factory: the configured one if named and usable, else the first usable one.
 *
 * Pure and exported, taking its factories and its credential lookup as arguments, so the rules can
 * be checked against providers that do not exist — which is the only way to test "prefers the
 * configured one over a usable one" while there is a single real implementation.
 *
 * @param preferred A provider id from configuration, or undefined to let the order decide.
 */
export function selectProvider<T>(
	factories: readonly ProviderFactory<T>[],
	lookup: CredentialLookup,
	preferred?: string
): ProviderFactory<T> {
	if (preferred !== undefined) {
		const named = factories.find((factory) => factory.descriptor.id === preferred);

		if (named === undefined) {
			// Configuration names something that is not installed. Refusing beats falling back,
			// because a fallback here is a silent disagreement with what the operator asked for.
			throw new ServiceFailure('not_configured');
		}

		if (!named.usable(lookup(named.descriptor.id))) throw notConfigured();

		return named;
	}

	const usable = factories.find((factory) => factory.usable(lookup(factory.descriptor.id)));

	if (usable === undefined) throw notConfigured();

	return usable;
}

/** Builds a provider once and reuses it, keyed by capability and id. */
function resolve<T>(
	factories: readonly ProviderFactory<T>[],
	capability: Capability,
	preferred?: string
): T {
	const factory = selectProvider(factories, credentialsFor, preferred);
	const key = `${capability}:${factory.descriptor.id}`;
	const existing = built.get(key);

	if (existing !== undefined) return existing as T;

	const instance = factory.create(credentialsFor(factory.descriptor.id));
	built.set(key, instance);

	return instance;
}

/**
 * The provider that answers live status.
 *
 * Throws `not_configured` rather than returning null: every caller would otherwise have to turn
 * null into exactly that refusal, and one of them eventually would not.
 */
export function liveProvider(preferred?: string): LiveProvider {
	return resolve(LIVE_PROVIDERS, 'live', preferred);
}

/** Whether anything can answer live status at all, for a page that wants to not render a panel. */
export function hasLiveProvider(preferred?: string): boolean {
	try {
		liveProvider(preferred);

		return true;
	} catch {
		return false;
	}
}

/** One provider's declared facts plus whether it is configured here. */
export interface ProviderStatus {
	readonly descriptor: ProviderDescriptor;
	readonly capability: Capability;
	readonly configured: boolean;
}

/**
 * Every registered provider and whether this deployment can use it.
 *
 * For the admin's integrations panel and the first-run setup, which need to show a provider that is
 * *available but not configured* rather than hiding it — "Restream: not set up" is useful and an
 * absent row is not.
 */
export function providerStatuses(): readonly ProviderStatus[] {
	return LIVE_PROVIDERS.map((factory) => ({
		descriptor: factory.descriptor,
		capability: 'live' as const,
		configured: factory.usable(credentialsFor(factory.descriptor.id))
	}));
}

/** Drops the built providers. For tests, which must not inherit another case's client. */
export function resetProviders(): void {
	built.clear();
}
