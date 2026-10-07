/**
 * The fan-out: one upstream connection in, many browsers out.
 *
 * ### There is no bus here, on purpose
 *
 * The obvious design is an in-process event bus that SSE sessions subscribe to. `better-sse`
 * already *is* that: a {@link Channel} holds sessions, broadcasts to them, drops the ones that have
 * gone away, and handles the heartbeat and `Last-Event-ID` replay that an idle proxy and a dropped
 * connection respectively require. A bus in front of it would be a second registry of the same
 * sessions, kept in step by hand.
 *
 * So the whole thing is one channel per topic. `publish()` is what the gateway calls; `register()`
 * is what the SSE route calls. Nothing else in the application knows either exists.
 *
 * ### One instance
 *
 * Channels are module state, so this works for exactly one SvelteKit process — which is what this
 * product is. A second instance is what forces a shared bus (Redis, Postgres `LISTEN`), and that is
 * a deployment change, not a transport change. Recorded here rather than discovered when someone
 * scales it out.
 */

import { Channel } from 'better-sse';
import type { Session } from 'better-sse';
import { TOPICS } from '#lib/events.js';
import type { SiteEvent, Topic } from '#lib/events.js';
import { log } from '#lib/server/log.js';

/**
 * How often to send a comment line to keep a stream open.
 *
 * Cloudflare and most other proxies drop an idle connection, and a quiet channel at 4am is idle for
 * minutes at a time. 20 seconds is inside every default timeout worth worrying about.
 *
 * This is the one setting in the transport whose failure is invisible: with no heartbeat everything
 * works locally, works under test, and is dropped behind a proxy after a minute of quiet — which
 * presents as a chat overlay that stops updating for no visible reason.
 */
const HEARTBEAT_MS = 20_000;

/** The widest interval any proxy worth supporting tolerates. */
export const HEARTBEAT_CEILING_MS = 30_000;

/**
 * The session options the SSE route uses.
 *
 * Here rather than in the route because a `+server.ts` may only export route things — SvelteKit
 * rejects anything else at build time, which is how this ended up in the right place.
 *
 * A function rather than an inline object literal at the call site so a test can assert what is
 * actually *passed*: a change that left {@link HEARTBEAT_MS} alone and disabled the keep-alive
 * where the session is built would satisfy any assertion about the constant while shipping a stream
 * that proxies drop.
 */
export const sessionOptions = (): { keepAlive: number } => ({ keepAlive: HEARTBEAT_MS });

/** One channel per topic, built once. */
const channels: ReadonlyMap<Topic, Channel> = new Map(
	TOPICS.map((topic) => [topic, new Channel()])
);

/**
 * Sends an event to every browser subscribed to its topic.
 *
 * The SSE event name is the topic, so a client can use `addEventListener('chat', …)` and let the
 * browser do the dispatch instead of switching on a field. The payload still carries `topic`,
 * because a client that registered one handler for everything needs it.
 */
export function publish(event: SiteEvent): void {
	channels.get(event.topic)?.broadcast(event, event.topic);
}

/**
 * Subscribes a session to the topics it asked for.
 *
 * A session with no topics is legitimate — see `topicsFrom` — and stays connected and silent rather
 * than being closed, so a client that asked for something this deployment does not have can tell
 * the difference between "no such topic" and "the server is down".
 */
export function register(session: Session, topics: readonly Topic[]): void {
	for (const topic of topics) {
		channels.get(topic)?.register(session);
	}
}

/** How many browsers are listening to each topic. For the admin, and for a sanity check in dev. */
export function listenerCounts(): Readonly<Record<Topic, number>> {
	return Object.fromEntries(
		TOPICS.map((topic) => [topic, channels.get(topic)?.sessionCount ?? 0])
	) as Record<Topic, number>;
}

/**
 * The upstream connection, if one has been started.
 *
 * Module-level rather than per-request because the point of the design is that there is exactly one
 * of it: the token never reaches a browser, the upstream sees one client instead of one per
 * visitor, and there is one reconnect implementation rather than one per tab.
 */
let stopGateway: (() => void) | null = null;

/**
 * Starts the upstream event connection, once.
 *
 * Called from the `init` hook. Deliberately forgiving: a deployment with no event provider
 * configured is a normal deployment, and the site works by polling the endpoints. A failure to
 * connect is logged and otherwise ignored, because a dead gateway must not stop the server from
 * serving pages — the provider's own reconnect handles the transient case.
 */
export async function startGateway(): Promise<void> {
	if (stopGateway !== null) return;

	// Imported here rather than at the top of the file to keep this module loadable by a test that
	// has no provider configuration. It is also the only direction the dependency can go: the
	// registry resolves providers, and a provider publishes through this module.
	const { eventProvider, hasEventProvider } = await import('#lib/server/providers/registry.js');

	if (!hasEventProvider()) {
		log().info('no event provider configured; the live parts of the page will poll');

		return;
	}

	try {
		stopGateway = await eventProvider().start(publish);
		log().info('event gateway connected');
	} catch (error) {
		log().error(
			{ err: error instanceof Error ? { name: error.name, message: error.message } : { error } },
			'event gateway failed to start'
		);
	}
}

/** Closes the upstream connection. For a clean shutdown, and for tests. */
export function stopEvents(): void {
	stopGateway?.();
	stopGateway = null;
}
