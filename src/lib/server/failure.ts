/**
 * Why something could not be answered, in words the client understands.
 *
 * Its own module rather than part of `endpoint.ts`, because **a provider must not import the HTTP
 * layer**. A provider's job is to fetch and translate; whether that becomes a 200 with
 * `ok: false` or a 500 is the endpoint's decision, and a third-party provider added later should
 * not have to know which.
 */

/**
 * The failure vocabulary.
 *
 * The client switches on these, so they are a contract and not a convenience. They are also
 * deliberately about *who has to act*:
 *
 * - `not_configured` — the operator has not set this up yet. Not an error; the page degrades.
 * - `token_rejected` — the operator's credential is wrong, expired, or lacks the scope.
 * - `upstream_unavailable` — someone else's service is down or rate-limiting. Temporary.
 * - `internal_error` — a bug here.
 * - `method_not_allowed` — the caller used the wrong verb.
 * - `not_authenticated` — no credential, or one no longer valid. Present one and retry.
 * - `not_permitted` — a valid credential that is not enough: the wrong role, or a read-only API
 *   token on something that writes. Retrying with the same credential will never work, which is
 *   the distinction from `not_authenticated` and the only reason these are two reasons.
 *
 * `token_rejected` is deliberately *not* reused for the last two. It means **the operator's
 * credential for somebody else's platform** was refused — a Twitch token that lapsed — and a client
 * that conflated them would tell a creator to re-link Twitch when the real answer was that the API
 * token they are calling with may only read.
 */
export type FailureReason =
	| 'not_configured'
	| 'token_rejected'
	| 'upstream_unavailable'
	| 'internal_error'
	| 'method_not_allowed'
	| 'not_authenticated'
	| 'not_permitted';

/**
 * Thrown by a provider or reader that knows which refusal it wants.
 *
 * The alternative — returning a discriminated union from every read — puts the error path into the
 * signature of code that mostly does not have one. Anything thrown that is *not* this is a bug, and
 * is reported as `internal_error` with the detail logged rather than returned.
 */
export class ServiceFailure extends Error {
	constructor(
		readonly reason: FailureReason,
		/** The HTTP status the endpoint should use. 200 for "this is a normal, expected state". */
		readonly status = 200
	) {
		super(reason);
		this.name = 'ServiceFailure';
	}
}

/** `not_configured`, which is the most common one and reads better than the constructor call. */
export function notConfigured(): ServiceFailure {
	return new ServiceFailure('not_configured');
}
