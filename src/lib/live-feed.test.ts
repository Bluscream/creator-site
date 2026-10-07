/**
 * The feed's one piece of pure logic: merging two time-ordered lists into one.
 *
 * `liveFeed()` itself is not tested here. It needs a browser's `EventSource` and `fetch`, and a
 * test that mocked both would mostly be asserting that the mocks were called — the transport it
 * talks to is already covered end to end in `src/lib/server/events.test.ts`. What *is* worth
 * pinning down is `interleave`, because the ordering it produces is the thing a reader sees and a
 * wrong one looks like a rendering quirk rather than a bug.
 */

import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '#lib/activity.js';
import type { Utterance } from '#lib/chat.js';
import { interleave } from '#lib/live-feed.svelte.js';

/** A message, with only the fields the ordering depends on filled in meaningfully. */
const message = (id: string, at: string): Utterance => ({
	id,
	platform: 'twitch',
	source: null,
	at,
	author: { name: 'Ada' },
	text: id,
	parts: [],
	notice: null
});

const entry = (id: string, at: string): ActivityEntry => ({
	id,
	platform: 'twitch',
	source: null,
	at,
	type: 'charity_donation',
	type_label: 'Donation',
	group: 'donation',
	actor: { name: 'Grace' },
	amount: 5,
	currency: 'EUR',
	count_name: 'euro',
	message: '',
	message_parts: [],
	system_message: '',
	colour: null
});

const idsOf = (rows: ReturnType<typeof interleave>): string[] =>
	rows.map((row) => (row.kind === 'message' ? row.message.id : row.entry.id));

describe('interleaving chat and support events', () => {
	it('puts both kinds in one list in time order', () => {
		const rows = interleave(
			[message('m1', '2026-10-06T13:00:00+00:00'), message('m2', '2026-10-06T13:00:02+00:00')],
			[entry('a1', '2026-10-06T13:00:01+00:00')]
		);

		expect(idsOf(rows)).toEqual(['m1', 'a1', 'm2']);
	});

	it('tags each row with which kind it is', () => {
		// The page branches on this to pick a component, so an untagged row would render as the
		// wrong one rather than not rendering.
		const rows = interleave(
			[message('m1', '2026-10-06T13:00:00+00:00')],
			[entry('a1', '2026-10-06T13:00:01+00:00')]
		);

		expect(rows.map((row) => row.kind)).toEqual(['message', 'activity']);
	});

	it('sorts by comparing the timestamp strings, which works because they are normalised', () => {
		// `localeCompare` on an ISO 8601 string at a fixed zero offset is lexical and happens to be
		// chronological. That is only true because `atom()` normalises every timestamp to exactly
		// that shape — same precision, same offset — which is why this is asserted here rather than
		// trusted. A `Z` suffix or a millisecond field mixed in would break it silently.
		const rows = interleave(
			[
				message('late', '2026-10-06T23:59:59+00:00'),
				message('early', '2026-10-06T00:00:00+00:00'),
				message('noon', '2026-10-06T12:00:00+00:00')
			],
			[]
		);

		expect(idsOf(rows)).toEqual(['early', 'noon', 'late']);
	});

	it('orders across a day boundary', () => {
		const rows = interleave(
			[message('next', '2026-10-07T00:00:01+00:00'), message('prev', '2026-10-06T23:59:59+00:00')],
			[]
		);

		expect(idsOf(rows)).toEqual(['prev', 'next']);
	});

	it('handles one side being empty', () => {
		expect(idsOf(interleave([message('m1', '2026-10-06T13:00:00+00:00')], []))).toEqual(['m1']);
		expect(idsOf(interleave([], [entry('a1', '2026-10-06T13:00:00+00:00')]))).toEqual(['a1']);
		expect(interleave([], [])).toEqual([]);
	});

	it('keeps both rows when a message and an event share a timestamp', () => {
		// A gift arrives on both feeds — as a chat notice and as an activity — and they can carry
		// the same second. Dropping either would lose a row; the page de-duplicates by id, not by
		// time, so this must not.
		const rows = interleave(
			[message('m1', '2026-10-06T13:00:00+00:00')],
			[entry('a1', '2026-10-06T13:00:00+00:00')]
		);

		expect(rows).toHaveLength(2);
	});

	it('does not mutate what it was given', () => {
		// `sort` is in-place, and these arrays are reactive state the page is rendering from.
		const messages = [
			message('m2', '2026-10-06T13:00:02+00:00'),
			message('m1', '2026-10-06T13:00:00+00:00')
		];
		const before = [...messages];

		interleave(messages, []);

		expect(messages).toEqual(before);
	});
});
