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
		expect(message.platform).toBe('twitch');
		expect(message.author.name).toBe('Ada');
		expect(message.author.colour).toBe('#1f8fff');
		expect(message.author.avatarUrl).toBe('https://example.invalid/ada.png');
		expect(message.text).toBe('first');
	});

	it('normalises the timestamp to second precision with an explicit zero offset', () => {
		// The SDK gives `…T13:17:09.482000Z`. The PHP emitted `…T13:17:09+00:00`, and a strict client
		// comparing strings would notice the difference.
		expect(describeMessage(PLAIN_MESSAGE).at).toBe('2026-10-06T13:17:09+00:00');
	});

	it('builds a profile link from the handle', () => {
		// Synchra reports the handle, never the public page, so this is the library building a url.
		expect(describeMessage(PLAIN_MESSAGE).author.profileUrl).toBe('https://www.twitch.tv/ada');
	});

	it('leaves an absent colour and an absent avatar off the actor entirely', () => {
		// Absent rather than null: `exactOptionalPropertyTypes` makes those different values, and a
		// renderer's `?? fallback` reads the same either way while a key-for-key comparison does not.
		const message = describeMessage(EMOTE_MESSAGE);

		expect(message.author).not.toHaveProperty('colour');
		expect(message.author).not.toHaveProperty('avatarUrl');
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
		const badges = describeMessage(EMOTE_MESSAGE).author.badges ?? [];

		expect(badges).toHaveLength(1);
		expect(badges[0]).toMatchObject({ name: 'Subscriber', type: 'subscriber' });
		expect(badges[0]?.imageUrl).toContain('badge-');
	});

	it('reads a notice from the field its content is actually in', () => {
		// The regression this exists for: a gift leaves `message_parts` empty and puts everything in
		// `notice_message_parts`. Reading only the former renders every gift as a blank row — a sixth
		// of the messages on a busy TikTok stream.
		const message = describeMessage(NOTICE_MESSAGE);

		expect(message.notice).toBe('tiktok_gift');
		expect(message.text).not.toBe('');
		expect(message.parts.length).toBeGreaterThan(0);
		expect(message.parts.some((part) => part.kind === 'gift')).toBe(true);
	});

	it('leaves an ordinary message with no notice at all', () => {
		expect(describeMessage(PLAIN_MESSAGE).notice).toBeNull();
	});

	it('still reads as a notice when the gateway does not name the kind', () => {
		// `notice` is one nullable string now, so "there is an event" and "which event" cannot
		// disagree — but a notice whose `sub_type` is missing must not thereby become an ordinary
		// message, which is what the fallback kind is for.
		const message = describeMessage({ ...NOTICE_MESSAGE, sub_type: null });

		expect(message.notice).toBe('notice');
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
			Date.parse(message.at ?? '')
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
		expect(entry.platform).toBe('twitch');
		expect(entry.type).toBe('charity_donation');
		expect(entry.type_label).toBe('Donation');
		expect(entry.group).toBe('donation');
		expect(entry.actor.name).toBe('Ada');
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

	it('leaves an absent avatar off the actor', () => {
		expect(describeActivity(GIFT).actor).not.toHaveProperty('avatarUrl');
	});

	it('normalises the timestamp the same way chat does', () => {
		expect(describeActivity(GIFT).at).toBe('2026-10-06T13:20:00+00:00');
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

	/**
	 * How a chat message's keys differ from the recorded PHP, and why.
	 *
	 * The canonical layer renamed these deliberately: `provider` → `platform` because posts and
	 * linked accounts already called it that, `created_at` → `at` for the same reason, and the five
	 * fields describing one person into a single `author`. The PHP recording is left as it was — it
	 * is a recording — so the divergence is stated here instead, which keeps an *accidental* change
	 * to the response shape a failing test while an intentional one has to be written down.
	 *
	 * The cutover consequence, noted in `.references/NODE_REWRITE.md`: the chat overlay's url moves
	 * to the Node route together with the page that reads it, not independently of it.
	 */
	const MESSAGE_RENAMES = {
		gone: ['avatar', 'badges', 'colour', 'created_at', 'kind', 'profile', 'provider', 'viewer'],
		added: ['at', 'author', 'platform', 'source']
	};

	const ACTIVITY_RENAMES = {
		gone: ['avatar', 'created_at', 'provider', 'viewer'],
		added: ['actor', 'at', 'platform', 'source']
	};

	/** What is in `keys` and not in `against`. */
	const missing = (keys: readonly string[], against: readonly string[]): string[] =>
		keys.filter((key) => !against.includes(key)).sort();

	it('diverges from the PHP message keys only where the canonical layer says so', () => {
		const keys = keysOf(describeMessage(PLAIN_MESSAGE));

		expect(missing(phpKeys.chat.message, keys)).toEqual(MESSAGE_RENAMES.gone);
		expect(missing(keys, phpKeys.chat.message)).toEqual(MESSAGE_RENAMES.added);
	});

	it('diverges from the PHP activity keys only where the canonical layer says so', () => {
		const keys = keysOf(describeActivity(DONATION));

		expect(missing(phpKeys.activity.entry, keys)).toEqual(ACTIVITY_RENAMES.gone);
		expect(missing(keys, phpKeys.activity.entry)).toEqual(ACTIVITY_RENAMES.added);
	});

	it('describes one person once, in the shape a post uses for its author', () => {
		// The point of the rename: five sibling fields became one actor, and it is the same actor
		// type a post carries — which is why there is one avatar component rather than two.
		expect(keysOf(describeMessage(PLAIN_MESSAGE).author)).toEqual([
			'avatarUrl',
			'colour',
			'name',
			'profileUrl'
		]);
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
		const badge = describeMessage(EMOTE_MESSAGE).author.badges?.[0];

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
