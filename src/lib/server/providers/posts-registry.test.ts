/**
 * That every source kind has been decided about.
 *
 * The registry keeps two tables — the kinds with a reader, and the kinds with a plan — and this
 * asserts they are a partition over `POST_SOURCE_KINDS`. That is the whole point: adding a kind to
 * the configuration schema without either writing its reader or saying what will fails here, rather
 * than shipping a kind an installer can configure and that then contributes nothing.
 */

import { describe, expect, it } from 'vitest';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import { implementedKinds, plannedKinds, postsSourceProvider } from './posts-registry.js';
import type { ResolvedSource } from './post.js';

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
	tiktok: '@someone'
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

describe('a kind with no reader', () => {
	it('throws rather than returning nothing if it is read anyway', async () => {
		const planned = plannedKinds()[0];

		if (planned === undefined) {
			// Everything is implemented, which is the goal. Nothing to assert.
			expect(plannedKinds()).toStrictEqual([]);

			return;
		}

		// An empty list would be a silently wrong answer indistinguishable from a quiet platform.
		// Reaching here at all means the orchestrator skipped its `unusable` check, which is a bug.
		await expect(
			Promise.resolve().then(() =>
				postsSourceProvider(planned).read(sourceOf(planned), {
					fetch: () => {
						throw new Error('must not fetch');
					},
					store: {
						get: () => Promise.resolve(null),
						put: () => Promise.resolve()
					}
				})
			)
		).rejects.toThrow(/no reader/);
	});
});
