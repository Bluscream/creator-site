/**
 * The common shape of every JSON endpoint under `/api/`.
 *
 * Ported from `Endpoint.php`. An endpoint names a browser cache TTL and hands over a reader; this
 * deals with headers, the method check, and failure. Failure means a JSON body with `ok: false` and
 * a reason — never a stack trace, never a 500 with an empty body, and never a token in a message.
 *
 * ### The response contract is deliberately byte-compatible with the PHP it replaces
 *
 * The migration is route-by-route behind nginx, so for a while the same page will be served by
 * whichever of the two answers. A client cannot be asked to cope with two response shapes, so this
 * reproduces the old one exactly — including the two details that are easy to get silently wrong:
 *
 * - **`generated_at` is `2026-10-07T04:07:08+00:00`**, which is PHP's `gmdate(DATE_ATOM)`. It is
 *   *not* `toISOString()`, which produces milliseconds and a `Z`. Both are valid ISO 8601 and a
 *   strict client comparing strings would notice.
 * - **Key order.** `ok` and `configured` come first, the payload next, `generated_at` last.
 *   Irrelevant to a JSON parser, and exactly what makes a recorded-response diff readable.
 *
 * The PHP responses were recorded while porting, and what the contract tests actually read is
 * `fixtures/php-feed-keys.json` — the key sets extracted from those recordings and committed. The
 * recordings themselves are not in the repository, so a test that needed them could not run on a
 * fresh clone; the extracted fixture can.
 */

import { ServiceFailure } from '#lib/server/failure.js';
import type { FailureReason } from '#lib/server/failure.js';
import { log } from '#lib/server/log.js';

/** The envelope this module builds. */
export type Payload = Record<string, unknown>;

/**
 * What a reader returns: the endpoint's own fields, merged into the envelope.
 *
 * `object` rather than `Record<string, unknown>` so a reader can return a declared interface. An
 * interface has no index signature and is not assignable to a Record, which would otherwise force
 * every reader to loosen its own return type — and a reader's return type is the response contract,
 * which is the last thing that should be loosened.
 */
export type ReaderResult = object;

export interface EndpointOptions {
	/** `Cache-Control: max-age`, in seconds. What the *browser* may reuse, not the server cache. */
	readonly browserCache: number;
}

/**
 * The timestamp format PHP's `gmdate(DATE_ATOM)` produces.
 *
 * `toISOString()` gives `…T04:07:08.123Z`; this gives `…T04:07:08+00:00`. Seconds precision and an
 * explicit zero offset, because that is what the recorded responses contain.
 */
export function generatedAt(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 19)}+00:00`;
}

function body(payload: Payload): string {
	// JSON.stringify already leaves unicode and slashes unescaped, which is what
	// JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES asked PHP for.
	return JSON.stringify({ ...payload, generated_at: generatedAt() });
}

function respond(status: number, payload: Payload, browserCache: number): Response {
	return new Response(body(payload), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'cache-control': `public, max-age=${String(browserCache)}, stale-while-revalidate=30`
		}
	});
}

/** A refusal, in the shape the client already understands. */
export function fail(status: number, reason: FailureReason, browserCache = 0): Response {
	return respond(status, { ok: false, reason }, browserCache);
}

/**
 * Runs a reader and wraps whatever it produces.
 *
 * **There is no method check here.** `Endpoint.php` had one, because a PHP file answers every
 * method that reaches it. A `+server.ts` exports one function per method and SvelteKit answers 405
 * for the rest on its own, so a check inside `GET` would be unreachable code. What the route adds
 * instead is a `fallback` export, so that 405 carries the same JSON envelope as every other
 * response rather than SvelteKit's plain-text default.
 *
 * `configured` is the old `json()`/`serve()` split, collapsed into a parameter: `json()` refused to
 * answer until a channel was configured and added `configured: true` to the envelope, while
 * `serve()` did neither. Two methods for one difference meant the post feed had to explain in a
 * docblock why it used the other one.
 *
 * @param ready Whether this endpoint's prerequisites are configured. `undefined` means the question
 *              does not apply, and no `configured` key is emitted — the old `serve()` behaviour.
 */
export async function serve(
	options: EndpointOptions,
	read: () => Promise<ReaderResult> | ReaderResult,
	ready?: boolean
): Promise<Response> {
	// Not a visitor error: the site has not been pointed at a channel yet, so the page degrades to
	// how it behaved before any of this existed.
	if (ready === false) {
		return respond(200, { ok: false, reason: 'not_configured', configured: false }, 0);
	}

	try {
		const payload = await read();
		const envelope: Payload = ready === undefined ? { ok: true } : { ok: true, configured: true };

		return respond(200, { ...envelope, ...payload }, options.browserCache);
	} catch (error) {
		return failureFor(error, options.browserCache);
	}
}

/**
 * Turns a thrown value into a response, logging only what is safe to log.
 *
 * An `EndpointFailure` is a decision the reader already made. Anything else is unexpected, so it is
 * logged with its class and message — pino's redact list keeps a credential out of that — and
 * answered as `internal_error`, which tells the client nothing about the inside of the server.
 */
function failureFor(error: unknown, browserCache: number): Response {
	if (error instanceof ServiceFailure) {
		return fail(error.status, error.reason, browserCache);
	}

	log().error(
		{ err: error instanceof Error ? { name: error.name, message: error.message } : { error } },
		'endpoint failed'
	);

	return fail(500, 'internal_error');
}

/**
 * The 405 a route's `fallback` returns.
 *
 * Separate from {@link fail} only so a route does not have to remember the status code, which is
 * the sort of thing that ends up as a 400 in one file and a 405 in the next.
 */
export function notAllowed(): Response {
	return fail(405, 'method_not_allowed');
}
