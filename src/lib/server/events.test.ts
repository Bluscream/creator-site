/**
 * The SSE transport, end to end, in-process.
 *
 * This drives the real route handler, reads the real `ReadableStream` it returns, and asserts that
 * an event published on the server arrives in the body as a spec-shaped SSE frame. No browser, no
 * credentials, no network — which matters, because the alternative is finding out the transport is
 * broken from a blank chat overlay.
 *
 * What it does *not* cover is the Synchra gateway at the other end of `publish()`; that needs a
 * token and a live channel. What it does cover is everything between `publish()` and the bytes.
 *
 * ### Two things about `better-sse` that were established by probing it, not by reading its README
 *
 * - **A session registers whether or not anyone reads the body.** The handler schedules the
 *   session's initialisation on a `setImmediate`, so the registration is never synchronous with the
 *   call but also never waits for a reader. A test that asked only for the headers and walked away
 *   therefore leaves a session registered forever — which is how the counts in this file first came
 *   to be wrong. Every connection here goes through {@link connect} so that every one is closed.
 * - **A client goes away by its request's `AbortSignal` and by nothing else** — not by its response
 *   stream being cancelled. SvelteKit's `getRequest` wires that signal to the socket closing (and,
 *   for a GET whose body was fully read, to the response closing), so a real browser navigating
 *   away does deregister. Cancelling the reader *as well* errors the underlying stream, and the
 *   library's cleanup then throws on its way to emitting `disconnected`, so the session is never
 *   deregistered at all. Hence {@link Client.leave} aborts and leaves the stream alone.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { TOPICS } from '#lib/events.js';
import { PLAIN_MESSAGE } from '#lib/server/fixtures/synchra-records.js';
import { describeMessage } from '#lib/server/providers/synchra.js';
import {
	HEARTBEAT_CEILING_MS,
	listenerCounts,
	publish,
	sessionOptions
} from '#lib/server/events.js';
import { GET, fallback } from '../../routes/api/events/+server.js';

/** One connected client: the response, a frame queue fed by a pump, and a way to go away. */
interface Client {
	readonly headers: Headers;
	readonly status: number;
	/**
	 * The next frame that carries an event, waiting a while for one. `''` when none arrives.
	 *
	 * Skips the frames the protocol sends on its own: `better-sse` opens every stream with a
	 * `retry:` line telling the browser how long to wait before reconnecting, and sends a bare
	 * comment as its heartbeat. Both are frames with no `event:` field, and a test that read the
	 * first frame and expected its own payload would read the retry line instead.
	 */
	readonly next: () => Promise<string>;
	/** What a browser navigating away does. */
	readonly leave: () => Promise<void>;
}

const connected = new Set<Client>();

afterEach(async () => {
	for (const client of connected) await client.leave();

	connected.clear();

	// Asserted rather than assumed: module-level channels mean a session this test forgot about
	// would silently become the next test's listener count.
	expect(total(listenerCounts())).toBe(0);
});

/** Lets the event loop run, so a `setImmediate` or an abort can propagate. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const total = (counts: Readonly<Record<string, number>>): number =>
	Object.values(counts).reduce((sum, count) => sum + count, 0);

/** Spins until a condition holds or the attempts run out, settling the loop between tries. */
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await settle();
}

/**
 * Connects to the endpoint and waits until the server has registered the session.
 *
 * The wait matters: publishing before the session is registered is a real race, and one that would
 * surface as a flaky test rather than a clear failure, so this polls the listener count instead of
 * sleeping for a guessed interval.
 *
 * Frames go into a queue as they arrive, rather than being awaited one call at a time, because the
 * pump is continuous — a second `read()` would otherwise wait for a frame that had already been
 * handed to the first.
 */
async function connect(topics?: string): Promise<Client> {
	const query = topics === undefined ? '' : `?topics=${topics}`;
	const url = new URL(`http://localhost/api/events${query}`);
	const aborter = new AbortController();
	const request = new Request(url, { method: 'GET', signal: aborter.signal });

	const response = await GET({ request, url } as RequestEvent);
	const body = response.body;

	if (body === null) throw new Error('the endpoint returned no body');

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const frames: string[] = [];
	const before = total(listenerCounts());

	// Its rejection when the connection ends is expected, and is the normal end of a client's life.
	const pump = (async () => {
		for (;;) {
			const chunk = await reader.read();

			// `done` narrows the result, so `value` is a chunk here and needs no guard.
			if (chunk.done) return;

			frames.push(decoder.decode(chunk.value));
		}
	})().catch(() => undefined);

	await until(() => total(listenerCounts()) > before);

	const client: Client = {
		headers: response.headers,
		status: response.status,
		next: async () => {
			await until(() => frames.some(carriesEvent));

			const index = frames.findIndex(carriesEvent);

			return index === -1 ? '' : (frames.splice(index, 1)[0] ?? '');
		},
		leave: async () => {
			aborter.abort();
			await until(() => total(listenerCounts()) === 0);
			await pump;
		}
	};

	connected.add(client);

	return client;
}

/**
 * The value of a named SSE field, across however many lines carry it.
 *
 * The space after the colon is optional in the wire format and `better-sse` does not write one —
 * its preamble is `retry:2000`. Both spellings are legal and `EventSource` accepts either, so this
 * accepts either too rather than pinning the test to one library's whitespace.
 */
function fieldOf(frame: string, name: string): string | null {
	const lines = frame
		.split('\n')
		.filter((line) => line.startsWith(`${name}:`))
		.map((line) => line.slice(name.length + 1).replace(/^ /, ''));

	return lines.length === 0 ? null : lines.join('');
}

/** Whether a frame is one of ours rather than a `retry:` preamble or a heartbeat comment. */
const carriesEvent = (frame: string): boolean => fieldOf(frame, 'event') !== null;

/** The event name a frame declares, which is the topic. */
const eventNameOf = (frame: string): string | null => fieldOf(frame, 'event');

/** The `data` field of a frame, parsed. */
function payloadOf(frame: string): unknown {
	const data = fieldOf(frame, 'data');

	if (data === null) throw new Error(`frame carries no data field: ${JSON.stringify(frame)}`);

	return JSON.parse(data);
}

describe('the events endpoint', () => {
	it('answers 200 with an event stream, not JSON', async () => {
		const client = await connect();

		expect(client.status).toBe(200);
		expect(client.headers.get('content-type')).toContain('text/event-stream');
	});

	it('tells proxies not to buffer it', async () => {
		// A buffered stream is delivered in one lump when it closes, which looks exactly like a
		// server that never sends anything — and is the commonest way SSE "does not work".
		const client = await connect();

		expect(client.headers.get('cache-control')).toContain('no-cache');
	});

	it('refuses a method EventSource would never use, in JSON', async () => {
		const response = await fallback({} as RequestEvent);

		expect(response.status).toBe(405);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toMatchObject({ ok: false, reason: 'method_not_allowed' });
	});

	it('connects with no event provider configured', async () => {
		// The deployment this is built for may have no gateway at all. Its pages poll, and this
		// endpoint still has to accept the connection rather than make every client branch on a
		// detail it cannot see. Nothing is configured in this test run, so this is that case.
		await connect();

		expect(total(listenerCounts())).toBeGreaterThan(0);
	});

	it('subscribes to every topic when none was named', async () => {
		await connect();

		expect(listenerCounts()).toEqual(Object.fromEntries(TOPICS.map((topic) => [topic, 1])));
	});

	it('counts one listener per topic a client subscribed to', async () => {
		await connect('chat,activity');

		const counts = listenerCounts();

		expect(counts.chat).toBe(1);
		expect(counts.activity).toBe(1);
		expect(counts.live).toBe(0);
	});

	it('delivers a published event to a subscribed client', async () => {
		const client = await connect('chat');
		const expected = describeMessage(PLAIN_MESSAGE);

		publish({ topic: 'chat', action: 'new', message: expected });

		const frame = await client.next();

		// The SSE event name is the topic, so a client can use addEventListener('chat', …) rather
		// than switching on a field.
		expect(eventNameOf(frame)).toBe('chat');
		// The payload is the same shape `GET /api/chat` returns, which is what lets a client fetch
		// the backlog and then stream with one renderer.
		expect(payloadOf(frame)).toMatchObject({ topic: 'chat', action: 'new', message: expected });
	});

	it('carries a deletion as an action rather than dropping it', async () => {
		// A moderator's deletion arrives on the same topic the message did. A client that ignores
		// `action` renders it as a brand new message — the opposite of what was asked for.
		const client = await connect('chat');

		publish({ topic: 'chat', action: 'deleted', message: describeMessage(PLAIN_MESSAGE) });

		expect(payloadOf(await client.next())).toMatchObject({ action: 'deleted' });
	});

	it('does not deliver another topic to a client that did not ask for it', async () => {
		// The reason topics exist: on a busy stream most of the traffic is chat, and a links page
		// that only wants the live badge should not be paying for it.
		const client = await connect('live');

		publish({ topic: 'chat', action: 'new', message: describeMessage(PLAIN_MESSAGE) });

		const counts = listenerCounts();

		expect(counts.live).toBe(1);
		expect(counts.chat).toBe(0);
		expect(await client.next()).toBe('');
	});

	it('deregisters a client that goes away', async () => {
		// The leak this guards against: a session that stays registered after the browser is gone
		// grows the fan-out forever on a public page. See the note at the top of this file for how
		// that disconnect is actually detected — this test is as much a record of that dependency on
		// SvelteKit's request signal as it is a check on the behaviour.
		const client = await connect('chat');

		expect(listenerCounts().chat).toBe(1);

		await client.leave();

		expect(listenerCounts().chat).toBe(0);
	});

	it('keeps the connection alive often enough for a proxy to tolerate it', () => {
		// A value check, not an observation, and deliberately so: watching a heartbeat arrive means
		// waiting the interval, and shortening the interval for the test would test a different
		// number than the one that ships.
		//
		// It earns its place because this was the one defect that the rest of this file missed —
		// setting `keepAlive: null` passed every other test here. With no heartbeat the stream works
		// locally, works under test, and is dropped by Cloudflare after a minute of quiet, which
		// presents as a chat overlay that stops updating for no visible reason.
		// `sessionOptions()` rather than the constant, so this checks what the handler passes.
		const { keepAlive } = sessionOptions();

		expect(keepAlive).toBeGreaterThan(0);
		expect(keepAlive).toBeLessThanOrEqual(HEARTBEAT_CEILING_MS);
	});

	it('publishing with nobody listening is not an error', () => {
		// The gateway runs whether or not anyone has the page open — it is also how the server learns
		// a stream went live — so this is the normal case at 4am, not an edge one.
		expect(total(listenerCounts())).toBe(0);
		expect(() => {
			publish({ topic: 'chat', action: 'new', message: describeMessage(PLAIN_MESSAGE) });
		}).not.toThrow();
	});
});
