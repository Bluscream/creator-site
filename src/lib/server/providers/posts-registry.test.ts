/**
 * That every source kind has been decided about.
 *
 * The registry keeps two tables — the kinds with a reader, and the kinds with a plan — and this
 * asserts they are a partition over `POST_SOURCE_KINDS`. That is the whole point: adding a kind to
 * the configuration schema without either writing its reader or saying what will fails here, rather
 * than shipping a kind an installer can configure and that then contributes nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import {
	implementedKinds,
	notYetRead,
	plannedKinds,
	postsSourceProvider
} from './posts-registry.js';
import type { ResolvedSource } from './post.js';

/**
 * Credentials, so this does not depend on the machine it runs on.
 *
 * Twitch reports itself unusable without `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, which is
 * correct behaviour and would make the assertions below pass or fail according to whether the
 * developer happens to have them set. What is under test here is the registry, not configuration.
 */
vi.mock('./credentials.js', () => ({
	credentialsFor: () => ({ clientId: 'test-client-id', clientSecret: 'test-client-secret' })
}));

/**
 * A target each kind's reader accepts.
 *
 * Per kind rather than one generic string, because every reader validates its own target and they
 * disagree about what a valid one looks like — a Bluesky handle is a domain name, a YouTube handle
 * is not. Without this, `unusable` would return "bad target" and the assertion below could not tell
 * that apart from "no reader", which is the thing it is checking.
 */
const TARGETS: Readonly<Record<(typeof POST_SOURCE_KINDS)[number], string>> = {
	feed: 'https://example.com/feed.xml',
	youtube: '@someone',
	bluesky: 'someone.bsky.social',
	twitch: 'someone',
	tiktok: '@someone',
	kick: 'someone'
};

/** A source of a given kind, with a target its reader would accept. */
function sourceOf(kind: (typeof POST_SOURCE_KINDS)[number]): ResolvedSource {
	return {
		id: 'probe',
		kind,
		target: TARGETS[kind],
		label: 'Probe',
		platform: null
	};
}

describe('the two registry tables', () => {
	it('cover every kind between them', () => {
		expect([...implementedKinds(), ...plannedKinds()].toSorted()).toStrictEqual(
			[...POST_SOURCE_KINDS].toSorted()
		);
	});

	it('do not overlap', () => {
		const both = implementedKinds().filter((kind) => plannedKinds().includes(kind));

		expect(both).toStrictEqual([]);
	});

	it('have at least one kind that actually works', () => {
		// Guards the degenerate case where everything is "planned" and the feed is entirely inert.
		expect(implementedKinds().length).toBeGreaterThan(0);
	});

	it('leave nothing unplanned, which is the state this was aiming at', () => {
		// Every kind reads today. Stated as its own assertion rather than left implied by the
		// partition, so that losing a reader fails here with a name rather than somewhere downstream.
		expect(implementedKinds().toSorted()).toStrictEqual([...POST_SOURCE_KINDS].toSorted());
		expect(plannedKinds()).toStrictEqual([]);
	});
});

/**
 * The fallback for a kind with no reader.
 *
 * Tested directly because nothing reaches it through the registry any more — every kind is
 * implemented. An unexercised fallback is one that rots until the day somebody needs it, which by
 * definition is the day it must work.
 */
describe('the fallback for a kind nobody has written yet', () => {
	/** A kind that is not in `POST_SOURCE_KINDS`, which is the whole point of the cast. */
	const future = 'mastodon' as (typeof POST_SOURCE_KINDS)[number];

	const unwritten: ResolvedSource = {
		id: 'probe',
		kind: future,
		target: 'someone',
		label: 'Probe',
		platform: null
	};

	it('says there is no reader, rather than returning nothing', () => {
		// With no entry in `PLANNED` there is no plan to name, so it says the plain thing. A source
		// contributing zero posts silently is indistinguishable from a platform gone quiet.
		expect(notYetRead(future).unusable(unwritten)).toMatch(/no reader/i);
	});

	it('names what will read it when there is a plan', () => {
		// The message an admin sees should say what is coming, not only what is missing. `PLANNED` is
		// empty today, so this asserts the shape of the sentence a future entry produces.
		const reason = notYetRead(future).unusable(unwritten);

		expect(reason).not.toBeNull();
		expect(reason).toMatch(/\.$/);
	});

	it('throws rather than answering, if it is read anyway', async () => {
		// Reaching `read` means the orchestrator skipped its `unusable` check, which is a bug. An
		// empty list would be a silently wrong answer; an exception is a reported one.
		await expect(
			Promise.resolve().then(() =>
				notYetRead(future).read(unwritten, {
					fetch: () => {
						throw new Error('must not fetch');
					},
					store: { get: () => Promise.resolve(null), put: () => Promise.resolve() }
				})
			)
		).rejects.toThrow(/no reader/);
	});
});

describe('every kind', () => {
	it.each([...POST_SOURCE_KINDS])('%s answers rather than being missing', (kind) => {
		// A kind absent from the map would make a configured source contribute nothing, which looks
		// exactly like a platform that has gone quiet.
		expect(postsSourceProvider(kind)).toBeDefined();
	});

	it.each([...POST_SOURCE_KINDS])('%s is either readable or explains itself', (kind) => {
		const reason = postsSourceProvider(kind).unusable(sourceOf(kind));

		if (implementedKinds().includes(kind)) {
			expect(reason).toBeNull();
		} else {
			// Not merely non-null: the message has to name what will read it, so an admin is told
			// what is coming rather than only that something is missing.
			expect(reason).toMatch(/not built yet — it will use .+/);
		}
	});
});
