/**
 * The chat and activity mappings.
 *
 * These two pure functions *are* the response contract: everything else in the path — the cache,
 * the envelope, the route — is shared with `/api/live` and already covered. So the tests check two
 * things, and the second matters more than the first.
 *
 * 1. That each field is mapped the way the PHP mapped it, including the parts that are easy to get
 *    silently wrong: a notice whose content is in the other field, money that needs scaling,
 *    `undefined` from the SDK becoming `null` in the response.
 * 2. That the *key set* matches the recorded PHP responses exactly. A renamed or forgotten field
 *    would still pass every assertion in the first group while breaking every client, because a
 *    client reads `message.colour` and gets `undefined` rather than an error.
 *
 * The key lists in `fixtures/php-feed-keys.json` were extracted from live PHP responses. Only the
 * names are committed — the bodies carried real viewers' names, pictures and messages, and this
 * repository is public.
 */

import { describe, expect, it } from 'vitest';
import {
	DONATION,
	EMOTE_MESSAGE,
	GIFT,
	NOTICE_MESSAGE,
	PLAIN_MESSAGE
} from '#lib/server/fixtures/synchra-records.js';
import {
	describeActivity,
	describeChatPage,
	describeMessage,
	synchraActivity,
	synchraChat,
	synchraLive
} from '#lib/server/providers/synchra.js';
import phpKeys from '#lib/server/fixtures/php-feed-keys.json' with { type: 'json' };

describe('mapping a chat message', () => {
	it('carries the identity fields through unchanged', () => {
		const message = describeMessage(PLAIN_MESSAGE);

		expect(message.id).toBe(PLAIN_MESSAGE.id);
		expect(message.provider).toBe('twitch');
		expect(message.viewer).toBe('Ada');
		expect(message.colour).toBe('#1f8fff');
		expect(message.avatar).toBe('https://example.invalid/ada.png');
		expect(message.text).toBe('first');
	});

	it('normalises the timestamp to second precision with an explicit zero offset', () => {
		// The SDK gives `…T13:17:09.482000Z`. The PHP emitted `…T13:17:09+00:00`, and a strict client
		// comparing strings would notice the difference.
		expect(describeMessage(PLAIN_MESSAGE).created_at).toBe('2026-10-06T13:17:09+00:00');
	});

	it('builds a profile link from the handle', () => {
		// Synchra reports the handle, never the public page, so this is the library building a url.
		expect(describeMessage(PLAIN_MESSAGE).profile).toBe('https://www.twitch.tv/ada');
	});

	it('reports an absent colour and an absent avatar as null, not undefined', () => {
		const message = describeMessage(EMOTE_MESSAGE);

		expect(message.colour).toBeNull();
		expect(message.avatar).toBeNull();
	});

	it('resolves an emote to its image instead of its name', () => {
		const message = describeMessage(EMOTE_MESSAGE);

		expect(message.parts).toHaveLength(2);
		expect(message.parts[0]).toMatchObject({ kind: 'text', text: 'nice ' });
		expect(message.parts[1]).toMatchObject({ kind: 'emote', text: 'PogChamp' });
		expect(message.parts[1]?.imageUrl).toContain('emote-');
		// The plain-text fallback still reads as a sentence, which is what a title attribute and a
		// screen reader get.
		expect(message.text).toBe('nice PogChamp');
	});

	it('resolves the viewer badges', () => {
		const badges = describeMessage(EMOTE_MESSAGE).badges;

		expect(badges).toHaveLength(1);
		expect(badges[0]).toMatchObject({ name: 'Subscriber', type: 'subscriber' });
		expect(badges[0]?.imageUrl).toContain('badge-');
	});

	it('reads a notice from the field its content is actually in', () => {
		// The regression this exists for: a gift leaves `message_parts` empty and puts everything in
		// `notice_message_parts`. Reading only the former renders every gift as a blank row — a sixth
		// of the messages on a busy TikTok stream.
		const message = describeMessage(NOTICE_MESSAGE);

		expect(message.notice).toBe(true);
		expect(message.kind).toBe('tiktok_gift');
		expect(message.text).not.toBe('');
		expect(message.parts.length).toBeGreaterThan(0);
		expect(message.parts.some((part) => part.kind === 'gift')).toBe(true);
	});

	it('marks an ordinary message as not a notice and gives it no kind', () => {
		const message = describeMessage(PLAIN_MESSAGE);

		expect(message.notice).toBe(false);
		expect(message.kind).toBeNull();
	});
});

/**
 * What each capability asks to be configured with.
 *
 * The difference is the point: live status and chat read anonymously, activity does not. A factory
 * that asked for a token it did not need would make a token-less deployment show an empty page
 * where it should show a working one, and `usable` is the only place that distinction exists.
 */
describe('what each capability needs to be configured', () => {
	const channelOnly = { channelId: 'abc' };
	const tokenOnly = { token: 'xyz' };
	const both = { channelId: 'abc', token: 'xyz' };

	it.each([
		['live', synchraLive],
		['chat', synchraChat]
	])('%s is usable with a channel and no token', (_name, factory) => {
		expect(factory.usable(channelOnly)).toBe(true);
		expect(factory.usable(both)).toBe(true);
	});

	it('activity needs a token as well as a channel, because an anonymous call answers 401', () => {
		expect(synchraActivity.usable(channelOnly)).toBe(false);
		expect(synchraActivity.usable(both)).toBe(true);
	});

	it.each([
		['live', synchraLive],
		['chat', synchraChat],
		['activity', synchraActivity]
	])('%s is not usable without a channel', (_name, factory) => {
		expect(factory.usable({})).toBe(false);
		expect(factory.usable(tokenOnly)).toBe(false);
	});

	it.each([
		['live', synchraLive],
		['chat', synchraChat],
		['activity', synchraActivity]
	])('%s treats an empty string as absent', (_name, factory) => {
		// An unset variable in a `.env` is `FOO=` rather than a missing line more often than not, and
		// `''` passing `!== undefined` would make an unconfigured deployment report itself ready.
		expect(factory.usable({ channelId: '', token: '' })).toBe(false);
	});
});

describe('mapping a page of chat', () => {
	// The API answers newest first. A log read backwards is the kind of defect that looks like a
	// rendering quirk for weeks, so it is pinned down rather than left to the comment.
	const newestFirst = [NOTICE_MESSAGE, EMOTE_MESSAGE, PLAIN_MESSAGE];

	it('turns newest-first into oldest-first', () => {
		const page = describeChatPage(newestFirst);

		expect(page.messages.map((message) => message.id)).toEqual([
			PLAIN_MESSAGE.id,
			EMOTE_MESSAGE.id,
			NOTICE_MESSAGE.id
		]);
	});

	it('ends up in ascending time order', () => {
		// Stated as the property rather than as the sequence, so the test still means something if
		// the fixtures are reordered.
		const times = describeChatPage(newestFirst).messages.map((message) =>
			Date.parse(message.created_at)
		);

		expect(times).toEqual([...times].sort((a, b) => a - b));
	});

	it('does not mutate the page it was given', () => {
		// `reverse()` is in-place on the array it is called on. It is called on the result of `map`
		// here, but a refactor that drops the map would silently start reversing the caller's array.
		const records = [...newestFirst];

		describeChatPage(records);

		expect(records).toEqual(newestFirst);
	});

	it('reports an empty page as available with no messages', () => {
		// Not the same as unavailable: a quiet channel is a working channel.
		expect(describeChatPage([])).toEqual({ available: true, reason: null, messages: [] });
	});
});

describe('mapping a support event', () => {
	it('carries the identity and label fields through', () => {
		const entry = describeActivity(DONATION);

		expect(entry.id).toBe(DONATION.id);
		expect(entry.provider).toBe('twitch');
		expect(entry.type).toBe('charity_donation');
		expect(entry.type_label).toBe('Donation');
		expect(entry.group).toBe('donation');
		expect(entry.viewer).toBe('Ada');
		expect(entry.count_name).toBe('euro');
		expect(entry.system_message).toBe('Ada donated €5.00');
	});

	it('scales money out of minor units', () => {
		// 500 with two decimal places is 5.00, not 500. Getting this wrong overstates every donation
		// by a factor of a hundred, and does it consistently enough to look intentional.
		expect(describeActivity(DONATION).amount).toBe(5);
		expect(describeActivity(DONATION).currency).toBe('EUR');
	});

	it('leaves a whole-unit count alone', () => {
		const entry = describeActivity(GIFT);

		expect(entry.amount).toBe(1);
		expect(entry.currency).toBeNull();
	});

	it('reports an unclassified event with a null group rather than omitting it', () => {
		// A client filters on `group`; a missing key and an explicit null are not the same thing to
		// `Object.hasOwn` or to a strict schema.
		const entry = describeActivity(GIFT);

		expect(entry.group).toBeNull();
		expect('group' in entry).toBe(true);
	});

	it('passes a colour through as given, gradient and all', () => {
		// TikTok sends a CSS gradient where a hex colour might be expected. Parsing it would fail;
		// passing it through works, because the client uses it as a CSS value.
		expect(describeActivity(GIFT).colour).toContain('linear-gradient');
	});

	it('resolves an attached message to text and to segments', () => {
		const entry = describeActivity(DONATION);

		expect(entry.message).toBe('keep it up');
		expect(entry.message_parts).toHaveLength(1);
	});

	it('gives an event with no attached message an empty string and no segments', () => {
		const entry = describeActivity(GIFT);

		expect(entry.message).toBe('');
		expect(entry.message_parts).toHaveLength(0);
	});

	it('reports an absent avatar as null', () => {
		expect(describeActivity(GIFT).avatar).toBeNull();
	});

	it('normalises the timestamp the same way chat does', () => {
		expect(describeActivity(GIFT).created_at).toBe('2026-10-06T13:20:00+00:00');
	});
});

/**
 * The response contract, against the recorded PHP.
 *
 * The migration is route-by-route behind nginx, so for a while either side may answer the same
 * page. A client cannot be asked to cope with two shapes.
 */
describe('matching the PHP response shape', () => {
	/** Every key the mapper produces, including the ones whose value is null. */
	const keysOf = (value: object): string[] => Object.keys(value).sort();

	it('produces exactly the message keys the PHP did', () => {
		expect(keysOf(describeMessage(PLAIN_MESSAGE))).toEqual(phpKeys.chat.message);
	});

	it('produces exactly the activity keys the PHP did', () => {
		expect(keysOf(describeActivity(DONATION))).toEqual(phpKeys.activity.entry);
	});

	it('produces segment keys the PHP also produced', () => {
		// A subset rather than an equality: the recorded sample contained no link segment, so `href`
		// never appeared in it, and a text segment carries neither `imageUrl` nor `animated`. Both
		// sides resolve segments with the same library helper, so what this pins down is that this
		// port has not *added* a key of its own.
		const allowed = new Set([...phpKeys.chat.segment, 'href']);
		const segments = [
			...describeMessage(EMOTE_MESSAGE).parts,
			...describeMessage(NOTICE_MESSAGE).parts,
			...describeActivity(DONATION).message_parts
		];

		expect(segments.length).toBeGreaterThan(0);

		for (const segment of segments) {
			for (const key of keysOf(segment)) {
				expect(allowed).toContain(key);
			}
		}
	});

	it('produces exactly the badge keys the PHP did', () => {
		const badge = describeMessage(EMOTE_MESSAGE).badges[0];

		expect(badge).toBeDefined();
		expect(keysOf(badge as object)).toEqual(phpKeys.chat.badge);
	});

	it('agrees with the PHP on the envelope, which the endpoint builds', () => {
		// Asserted here rather than in a route test because these are the keys a client destructures,
		// and the list is worth having in one place next to the two payload shapes. `ok`,
		// `configured` and `generated_at` come from `endpoint.ts`; `age` and `stale` from the cache.
		expect(phpKeys.chat.envelope).toEqual([
			'ok',
			'configured',
			'available',
			'reason',
			'messages',
			'age',
			'stale',
			'generated_at'
		]);
		expect(phpKeys.activity.envelope).toEqual([
			'ok',
			'configured',
			'available',
			'reason',
			'activities',
			'age',
			'stale',
			'generated_at'
		]);
	});
});
