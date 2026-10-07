import { describe, expect, it } from 'vitest';
import { apiHostPath, isApiHost } from '#lib/api-host.js';

const at = (href: string): URL => new URL(href);

describe('recognising the API hostname', () => {
	it.each([
		['https://api.example.com/live', true],
		['https://API.Example.com/live', true],
		['https://api.example.com:3000/live', true],
		['https://example.com/api/live', false],
		['https://www.example.com/live', false],
		// The prefix is a whole leading label, not a substring anywhere in the host. Each of these
		// contains `api` — and `my-api.` even contains the literal `api.` — and none of them is the
		// API host. Without these, `includes()` in place of `startsWith()` passes every other case.
		['https://apidocs.example.com/live', false],
		['https://my-api.example.com/live', false],
		['https://rapid.example.com/live', false],
		['https://staging.api.example.com/live', false]
	])('%s → %s', (href, expected) => {
		expect(isApiHost(at(href))).toBe(expected);
	});
});

describe('rewriting a request on the API hostname', () => {
	it.each([
		['https://api.example.com/live', '/api/live'],
		['https://api.example.com/chat', '/api/chat'],
		['https://api.example.com/posts', '/api/posts']
	])('%s → %s', (href, expected) => {
		expect(apiHostPath(at(href))).toBe(expected);
	});

	it('does not double the prefix when a client writes it out', () => {
		// A client being explicit on the API host meant the same endpoint and should not get a 404
		// for saying so.
		expect(apiHostPath(at('https://api.example.com/api/live'))).toBe('/api/live');
	});

	it('maps the API root to the API root, not to the front page', () => {
		// Serving the links page on the API hostname would give it a second canonical URL.
		expect(apiHostPath(at('https://api.example.com/'))).toBe('/api');
	});

	it('leaves a request on the site hostname alone', () => {
		expect(apiHostPath(at('https://example.com/live'))).toBeNull();
		expect(apiHostPath(at('https://example.com/api/live'))).toBeNull();
	});

	it('is a rewrite and keeps nothing of the host', () => {
		// A redirect would turn every API call into two round trips and would drop a POST body, so
		// the result is a path for SvelteKit to match — never an absolute URL.
		const path = apiHostPath(at('https://api.example.com/live'));

		expect(path?.startsWith('/')).toBe(true);
		expect(path).not.toContain('://');
	});

	it('ignores the query string, which SvelteKit matches separately', () => {
		expect(apiHostPath(at('https://api.example.com/live?refresh=1'))).toBe('/api/live');
	});
});
