/**
 * That the two tables are a partition over every source kind.
 *
 * The same check `posts-registry.test.ts` makes, and for the same reason: adding a kind to the
 * configuration schema without either writing its metrics reader or saying what will fails here,
 * rather than shipping a kind an installer can configure and that then silently reports nothing —
 * which on a metrics page looks exactly like a platform with nothing to report.
 */

import { describe, expect, it } from 'vitest';
import { POST_SOURCE_KINDS } from './posts-kinds.js';
import {
	measuredKinds,
	metricsSourceProvider,
	notYetMeasured,
	plannedMetricKinds
} from './metrics-registry.js';
import type { ResolvedSource } from './post.js';

/** A source of the given kind, with the rest filled in. */
function source(kind: (typeof POST_SOURCE_KINDS)[number]): ResolvedSource {
	return { id: kind, kind, target: 'someone', label: kind, platform: kind };
}

describe('the two tables', () => {
	it('cover every kind between them', () => {
		expect([...measuredKinds(), ...plannedMetricKinds()].toSorted()).toStrictEqual(
			[...POST_SOURCE_KINDS].toSorted()
		);
	});

	it('do not overlap', () => {
		const both = measuredKinds().filter((kind) => plannedMetricKinds().includes(kind));

		expect(both).toStrictEqual([]);
	});

	it('have at least one kind whose numbers are really read', () => {
		// Guards the degenerate state this file could easily have shipped in: a seam, a page and a
		// table of promises, with nothing actually reading anything. Bluesky is that one, because
		// its profile counts need no credential.
		expect(measuredKinds()).toContain('bluesky');
	});
});

describe('a provider for every kind', () => {
	it.each([...POST_SOURCE_KINDS])('answers for %s rather than being absent', (kind) => {
		// Total by construction: a missing entry would be a configured source absent from the page.
		expect(typeof metricsSourceProvider(kind).read).toBe('function');
	});

	it.each([...plannedMetricKinds()])('explains what %s is waiting for', (kind) => {
		const refusal = metricsSourceProvider(kind).unusable(source(kind));

		// Not merely non-null: the sentence has to name what is needed. "Not implemented" is not
		// something an admin can act on; "once the channel is linked" is.
		expect(refusal).toMatch(/it will use /);
	});

	it('refuses a kind it has no plan for, without pretending to have one', () => {
		// Reached only if a kind is added to `POST_SOURCE_KINDS` and to neither table — which the
		// partition test above fails on. Exercised directly because that is the only way this branch
		// is ever run, and an unreachable message is one that rots.
		const refusal = notYetMeasured('not-a-kind' as (typeof POST_SOURCE_KINDS)[number]).unusable(
			source('feed')
		);

		expect(refusal).toBe('Numbers from this kind of source are not read.');
	});

	it('throws rather than returning nothing when an unreadable kind is read anyway', () => {
		// Unreachable: the orchestrator asks `unusable` first. An empty list would be a silently
		// wrong answer, and arriving here is a programming error.
		expect(() => metricsSourceProvider('youtube').read(source('youtube'), {} as never)).toThrow(
			/no metrics reader/
		);
	});
});
