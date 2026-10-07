/**
 * The response envelope, checked against the PHP it has to be compatible with.
 *
 * The migration is route-by-route behind nginx, so for a while a page may be served by either
 * implementation. A client cannot be asked to cope with two shapes, so the recorded PHP response in
 * `fixtures/php-live.json` is the contract — including the timestamp format, which is the detail
 * most likely to drift unnoticed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ServiceFailure } from '#lib/server/failure.js';
import { fail, generatedAt, notAllowed, serve } from '#lib/server/endpoint.js';

/**
 * The envelope every response carries, plus whatever the endpoint added.
 *
 * An index signature rather than `Record<string, unknown>`, so the fields that are part of the
 * contract are named and type-checked while a test can still reach for a payload key it put there.
 */
interface Envelope {
	ok: boolean;
	reason?: string;
	configured?: boolean;
	generated_at: string;
	[key: string]: unknown;
}

const PHP_LIVE = JSON.parse(
	readFileSync('src/lib/server/fixtures/php-live.json', 'utf8')
) as Envelope;

async function bodyOf(response: Response): Promise<Envelope> {
	return (await response.json()) as Envelope;
}

describe('the generated_at timestamp', () => {
	it('matches the format the PHP emitted', () => {
		expect(generatedAt(new Date('2026-10-07T04:07:08.123Z'))).toBe('2026-10-07T04:07:08+00:00');
	});

	it('is the same shape as the recorded response', () => {
		// Not a string comparison of the value — a comparison of the *format*, which is what a
		// client parsing or sorting these actually depends on.
		const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

		expect(PHP_LIVE.generated_at).toMatch(shape);
		expect(generatedAt()).toMatch(shape);
	});

	it('is not toISOString, which is the mistake this exists to prevent', () => {
		const at = new Date('2026-10-07T04:07:08.123Z');

		expect(generatedAt(at)).not.toBe(at.toISOString());
	});
});

describe('a successful response', () => {
	it('wraps the reader in the envelope, with generated_at last', async () => {
		const response = await serve({ browserCache: 15 }, () => ({ any_live: false }), true);

		expect(response.status).toBe(200);
		expect(Object.keys(await bodyOf(response))).toStrictEqual([
			'ok',
			'configured',
			'any_live',
			'generated_at'
		]);
	});

	it('omits `configured` when the question does not apply', async () => {
		// The old `serve()` behaviour: the post feed is not a Synchra read and had no channel
		// requirement, so answering `configured: true` would have been a claim about nothing.
		const response = await serve({ browserCache: 60 }, () => ({ posts: [] }));

		expect(Object.keys(await bodyOf(response))).toStrictEqual(['ok', 'posts', 'generated_at']);
	});

	it('sends the headers the PHP sent', async () => {
		const response = await serve({ browserCache: 15 }, () => ({}), true);

		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=15, stale-while-revalidate=30'
		);
	});

	it('awaits an async reader', async () => {
		const response = await serve({ browserCache: 0 }, async () => Promise.resolve({ n: 1 }), true);

		expect((await bodyOf(response)).n).toBe(1);
	});
});

describe('an unconfigured endpoint', () => {
	it('answers 200 with the reason, because it is not a visitor error', async () => {
		// The page degrades to how it behaved before any of this existed. A 500 here would put an
		// error in every visitor's console for a site that is merely not set up yet.
		const response = await serve({ browserCache: 15 }, () => ({ never: true }), false);

		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toMatchObject({
			ok: false,
			reason: 'not_configured',
			configured: false
		});
	});

	it('does not run the reader', async () => {
		let ran = false;

		await serve(
			{ browserCache: 15 },
			() => {
				ran = true;

				return {};
			},
			false
		);

		expect(ran).toBe(false);
	});

	it('is not cached by the browser', async () => {
		// Otherwise finishing the setup would not take effect until the max-age expired.
		const response = await serve({ browserCache: 300 }, () => ({}), false);

		expect(response.headers.get('cache-control')).toContain('max-age=0');
	});
});

describe('a failing reader', () => {
	it('passes a ServiceFailure through with its reason and status', async () => {
		const response = await serve(
			{ browserCache: 15 },
			() => {
				throw new ServiceFailure('upstream_unavailable');
			},
			true
		);

		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toMatchObject({ ok: false, reason: 'upstream_unavailable' });
	});

	it('honours a failure that asks for a non-200', async () => {
		const response = await serve(
			{ browserCache: 15 },
			() => {
				throw new ServiceFailure('internal_error', 500);
			},
			true
		);

		expect(response.status).toBe(500);
	});

	it('turns anything else into internal_error, telling the client nothing else', async () => {
		const response = await serve(
			{ browserCache: 15 },
			() => {
				throw new TypeError('secretBaseUrl is not a function');
			},
			true
		);

		const parsed = await bodyOf(response);

		expect(response.status).toBe(500);
		expect(parsed.reason).toBe('internal_error');
		// The detail goes to the log, never to the response: a stack or a message can name internals.
		expect(JSON.stringify(parsed)).not.toContain('secretBaseUrl');
	});

	it('does not leak a thrown non-Error either', async () => {
		const response = await serve(
			{ browserCache: 15 },
			() => {
				// Throwing a non-Error is exactly what this case is about: a value that is not an
				// Error must still not have its contents returned to the client.
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
				throw 'a bare string with an api key in it';
			},
			true
		);

		expect(JSON.stringify(await bodyOf(response))).not.toContain('api key');
	});
});

describe('refusals', () => {
	it('shapes a 405 like every other response', async () => {
		// SvelteKit answers 405 itself, in plain text; a route's `fallback` returns this so a client
		// can parse every response the same way.
		const response = notAllowed();

		expect(response.status).toBe(405);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(await bodyOf(response)).toMatchObject({ ok: false, reason: 'method_not_allowed' });
	});

	it('always carries a timestamp, like a success does', async () => {
		expect(await bodyOf(fail(500, 'internal_error'))).toHaveProperty('generated_at');
	});
});
