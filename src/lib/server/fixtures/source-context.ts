/**
 * Stand-ins for what a post source provider is handed, for tests.
 *
 * Here rather than in one of the test files so two suites can share them without importing each
 * other — a test file that another test file imports runs twice, once per importer, and its
 * lifecycle hooks run in the wrong suite.
 */

import type { SourceContext } from '#lib/server/providers/posts-source.js';

/**
 * The provider store, in memory.
 *
 * A real one rather than a stub that always answers nothing, so a provider that caches an
 * identifier is actually exercised instead of silently taking its uncached path in every test.
 *
 * Ages are always zero, which is the honest simplification: nothing stored here has been there for
 * any length of time. A test about expiry sets the age it wants.
 */
export function memoryStore(): SourceContext['store'] {
	const values = new Map<string, string>();

	return {
		get: (key) => {
			const value = values.get(key);

			return Promise.resolve(value === undefined ? null : { value, age: 0 });
		},

		put: (key, value) => {
			values.set(key, value);

			return Promise.resolve();
		}
	};
}

/** A context whose fetch answers every request with one body, so nothing leaves the process. */
export function serving(
	body: string,
	init: { readonly status?: number; readonly headers?: Record<string, string> } = {}
): SourceContext {
	return {
		fetch: () =>
			Promise.resolve(
				new Response(body, {
					status: init.status ?? 200,
					headers: init.headers ?? { 'content-type': 'application/xml' }
				})
			),
		store: memoryStore()
	};
}
