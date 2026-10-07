import { describe, expect, it } from 'vitest';
import { EVENT_ACTIONS, TOPICS, isTopic, topicsFrom } from '#lib/events.js';

describe('recognising a topic', () => {
	it.each([...TOPICS])('%s is a topic', (topic) => {
		expect(isTopic(topic)).toBe(true);
	});

	it.each(['', 'posts', 'Chat', 'chat ', 'calendar'])('%o is not', (value) => {
		// Case- and whitespace-sensitive on purpose: these are protocol tokens, not user input, and a
		// client that sends `Chat` has a bug worth noticing rather than papering over.
		expect(isTopic(value)).toBe(false);
	});
});

describe('reading the ?topics= parameter', () => {
	it('treats an absent parameter as every topic', () => {
		// What a debugging `curl` sends, and what a client that wants everything should not have to
		// enumerate — the list would then need updating in two places per new topic.
		expect(topicsFrom(null)).toEqual(TOPICS);
	});

	it.each(['', '   '])('treats %o as every topic too', (value) => {
		expect(topicsFrom(value)).toEqual(TOPICS);
	});

	it('keeps only what was asked for', () => {
		expect(topicsFrom('chat')).toEqual(['chat']);
		expect(topicsFrom('chat,live')).toEqual(['chat', 'live']);
	});

	it('tolerates the spacing a hand-written URL has', () => {
		expect(topicsFrom('chat, live')).toEqual(['chat', 'live']);
	});

	it('answers in a stable order however the client spelled it', () => {
		// Otherwise two clients asking for the same thing get different subscription sets, and a bug
		// that depends on registration order would only show up for one of them.
		expect(topicsFrom('live,chat')).toEqual(topicsFrom('chat,live'));
	});

	it('removes duplicates', () => {
		expect(topicsFrom('chat,chat,chat')).toEqual(['chat']);
	});

	it('ignores a name it does not know rather than refusing the request', () => {
		// A client built against a later version asking for a topic this deployment lacks should get
		// the ones it does have. Refusing would make a forward-compatible client worse off than an
		// old one.
		expect(topicsFrom('chat,telepathy')).toEqual(['chat']);
	});

	it('subscribes to nothing when nothing asked for was known', () => {
		// Not "everything": falling back to the full set here would flood a client that asked for one
		// specific thing. A connected, silent stream is something the client can detect.
		expect(topicsFrom('telepathy')).toEqual([]);
	});
});

describe('the action list', () => {
	it('includes deletion, which is not a separate topic', () => {
		// The one that gets forgotten: a moderator's deletion arrives on the same topic as the
		// message did, and a client that ignores `action` renders it as a new message.
		expect(EVENT_ACTIONS).toContain('deleted');
	});
});
