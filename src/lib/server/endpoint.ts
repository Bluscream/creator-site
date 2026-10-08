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

import { isHttpError } from '@sveltejs/kit';
import { ServiceFailure } from '#lib/server/failure.js';
import type { FailureReason } from '#lib/server/failure.js';
import type { HttpError } from '@sveltejs/kit';
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

/** Who may store a response. See {@link EndpointOptions.visibility}. */
export type Visibility = 'public' | 'private';

export interface EndpointOptions {
	/** `Cache-Control: max-age`, in seconds. What the *browser* may reuse, not the server cache. */
	readonly browserCache: number;

	/**
	 * Who may store the response. `'public'` by default, which is right for everything unguarded.
	 *
	 * **`'private'` is mandatory for anything behind a guard.** `public` on an authenticated
	 * response is a standing instruction to every shared cache in the path — a CDN, a company
	 * proxy — that it may serve one admin's figures to the next caller who asks for the same URL.
	 * It is also the kind of mistake that behaves perfectly in development, where there is no
	 * shared cache, and leaks the first time the site is put behind one.
	 *
	 * `'private'` emits `private, no-store` and varies on the credential headers, so nothing stores
	 * it and nothing keyed on the path alone can confuse two callers. `browserCache` is ignored:
	 * there is no number of seconds for which storing an admin's data is correct.
	 */
	readonly visibility?: Visibility;
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

function respond(
	status: number,
	payload: Payload,
	browserCache: number,
	visibility: Visibility = 'public'
): Response {
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'cache-control':
			visibility === 'private'
				? 'private, no-store'
				: `public, max-age=${String(browserCache)}, stale-while-revalidate=30`
	};

	// Belt as well as braces. `no-store` already forbids storing this, and a cache that ignored it
	// would at least not key two callers' responses together. Both headers, because the failure
	// being guarded against is somebody else's misconfigured proxy rather than this code.
	if (visibility === 'private') headers.vary = 'Authorization, Cookie';

	return new Response(body(payload), { status, headers });
}

/** A refusal, in the shape the client already understands. */
export function fail(
	status: number,
	reason: FailureReason,
	browserCache = 0,
	visibility: Visibility = 'public'
): Response {
	return respond(status, { ok: false, reason }, browserCache, visibility);
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
 * ### A guarded endpoint calls its guard *inside* the reader
 *
 * `requireApi` and friends throw SvelteKit's `HttpError`, and this catches it — so a 401 or a 403
 * comes back in the same envelope as every other response, with the same `private, no-store`
 * headers. Calling the guard before `serve` instead would let Kit render its own HTML-ish error
 * page for an API route, and would hand a refusal to whatever shared cache is in the path with no
 * cache directives at all.
 *
 * @param ready Whether this endpoint's prerequisites are configured. `undefined` means the question
 *              does not apply, and no `configured` key is emitted — the old `serve()` behaviour.
 */
export async function serve(
	options: EndpointOptions,
	read: () => Promise<ReaderResult> | ReaderResult,
	ready?: boolean
): Promise<Response> {
	const { visibility } = options;

	// Not a visitor error: the site has not been pointed at a channel yet, so the page degrades to
	// how it behaved before any of this existed.
	if (ready === false) {
		return respond(200, { ok: false, reason: 'not_configured', configured: false }, 0, visibility);
	}

	try {
		const payload = await read();
		const envelope: Payload = ready === undefined ? { ok: true } : { ok: true, configured: true };

		return respond(200, { ...envelope, ...payload }, options.browserCache, visibility);
	} catch (error) {
		return failureFor(error, options.browserCache, visibility);
	}
}

/**
 * A guard's refusal, as this module's envelope.
 *
 * Only 401 and 403 are translated. Every other `HttpError` reaching here came from somewhere that
 * is not a guard — a `redirect` a reader had no business issuing, a `404` from deeper in — and
 * passing those through as an authentication answer would be inventing a reason.
 */
function refusalFor(error: HttpError): { status: number; reason: FailureReason } | null {
	if (error.status === 401) return { status: 401, reason: 'not_authenticated' };
	if (error.status === 403) return { status: 403, reason: 'not_permitted' };

	return null;
}

/**
 * Turns a thrown value into a response, logging only what is safe to log.
 *
 * An `EndpointFailure` is a decision the reader already made. Anything else is unexpected, so it is
 * logged with its class and message — pino's redact list keeps a credential out of that — and
 * answered as `internal_error`, which tells the client nothing about the inside of the server.
 *
 * A guard's 401 or 403 is a decision too, and is **not** logged: a wrong credential is an ordinary
 * event on a public internet, and logging each one turns an unauthenticated scan into a disk-filling
 * exercise somebody else controls.
 */
function failureFor(error: unknown, browserCache: number, visibility?: Visibility): Response {
	if (error instanceof ServiceFailure) {
		return fail(error.status, error.reason, browserCache, visibility);
	}

	if (isHttpError(error)) {
		const refusal = refusalFor(error);

		// A refusal is never cached, whatever the endpoint's own TTL says: the answer depends
		// entirely on who asked.
		if (refusal !== null) return fail(refusal.status, refusal.reason, 0, visibility);
	}

	log().error(
		{ err: error instanceof Error ? { name: error.name, message: error.message } : { error } },
		'endpoint failed'
	);

	return fail(500, 'internal_error', 0, visibility);
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
