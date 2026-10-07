/**
 * That Twitch VODs and clips become posts.
 *
 * Credentials are mocked rather than read, which is the point: a provider test that depended on a
 * real client secret would pass on one machine and fail in CI, and the thing worth testing is the
 * token dance rather than whether an application exists.
 *
 * **Not verified against live Helix.** Everything here is asserted against the shapes Twitch
 * documents and against the PHP implementation this ports, not against a response from Twitch. The
 * one reader in this project where that is true.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { SourceContext } from './posts-source.js';
import { loginOf, thumbnail, twitchSourceProvider } from './twitch-source.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

vi.mock('./credentials.js', () => ({
	credentialsFor: vi.fn(() => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
}));

const { credentialsFor } = await import('./credentials.js');

const source: ResolvedSource = {
	id: 'twitch',
	kind: 'twitch',
	target: 'someone',
	label: 'Twitch',
	platform: 'twitch'
};

/** One VOD, with the fields Helix documents for `Get Videos`. */
const VIDEO = {
	id: '335921245',
	stream_id: '41375541868',
	user_id: '141981764',
	user_name: 'Someone',
	title: 'VR und Chill mit dem Otter',
	description: 'A long stream about otters.',
	created_at: '2026-10-01T13:31:57Z',
	published_at: '2026-10-01T13:31:57Z',
	url: 'https://www.twitch.tv/videos/335921245',
	thumbnail_url: 'https://static-cdn.jtvnw.net/cf_vods/abc/thumb/thumb0-%{width}x%{height}.jpg',
	viewable: 'public',
	view_count: 1863,
	type: 'archive',
	duration: '3h8m33s'
};

/** One clip, with the fields Helix documents for `Get Clips`. */
const CLIP = {
	id: 'AwkwardHelplessSalamanderSwiftRage',
	url: 'https://clips.twitch.tv/AwkwardHelplessSalamanderSwiftRage',
	broadcaster_id: '67955580',
	broadcaster_name: 'Someone',
	creator_id: '53888434',
	creator_name: 'A Viewer',
	title: 'The otter moment',
	// Already sized, with no placeholders — a different spelling from a VOD's.
	thumbnail_url: 'https://clips-media-assets.twitch.tv/abc-preview-480x272.jpg',
	view_count: 10,
	created_at: '2026-09-28T09:45:04Z',
	duration: 12.9
};

/** A store whose ages the test controls. */
function store(ages: Readonly<Record<string, number>> = {}): SourceContext['store'] {
	const values = new Map<string, string>();

	return {
		get: (key) => {
			const value = values.get(key);

			return Promise.resolve(
				value === undefined ? null : { value, age: ages[key.split('\0')[0] ?? ''] ?? 0 }
			);
		},
		put: (key, value) => {
			values.set(key, value);

			return Promise.resolve();
		}
	};
}

/** One answer to one request. */
interface Answer {
	readonly status?: number;
	readonly body?: unknown;
}

/** A request this context received. */
interface Call {
	readonly url: string;
	readonly method: string;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * A route as a list, whether it was written as one or not.
 *
 * A predicate rather than an inline `Array.isArray`, which widens a `readonly Answer[]` to `any[]`
 * and loses every field on the way through.
 */
function listed(route: Answer | readonly Answer[]): readonly Answer[] {
	return isList(route) ? route : [route];
}

function isList(route: Answer | readonly Answer[]): route is readonly Answer[] {
	return Array.isArray(route);
}

/**
 * A context routing by url fragment, so a test says what each endpoint answers.
 *
 * A route may be a list, consumed one answer per call — which is how the 401-then-success retry is
 * expressed without a stateful mock.
 */
function routing(
	routes: Readonly<Record<string, Answer | readonly Answer[]>>,
	ages?: Readonly<Record<string, number>>
): SourceContext & { readonly calls: Call[] } {
	const calls: Call[] = [];
	const used = new Map<string, number>();

	return {
		calls,
		store: store(ages),
		fetch: (url, init) => {
			calls.push({
				url,
				method: init?.method ?? 'GET',
				body: init?.body,
				headers: init?.headers ?? {}
			});

			const key = Object.keys(routes).find((fragment) => url.includes(fragment));

			if (key === undefined) throw new Error(`no route for ${url}`);

			const route = routes[key];
			const answers = route === undefined ? [] : listed(route);
			const index = used.get(key) ?? 0;

			used.set(key, index + 1);

			const answer = answers[Math.min(index, answers.length - 1)] ?? {};

			return Promise.resolve(
				new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
					status: answer.status ?? 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		}
	};
}

/** The routes a successful read needs. */
function working(overrides: Readonly<Record<string, Answer | readonly Answer[]>> = {}) {
	return routing({
		'oauth2/token': { body: { access_token: 'an-app-token', expires_in: 5_000_000 } },
		'helix/users': { body: { data: [{ id: '141981764', login: 'someone' }] } },
		'helix/videos': { body: { data: [VIDEO] } },
		'helix/clips': { body: { data: [CLIP] } },
		...overrides
	});
}

beforeEach(() => {
	vi.mocked(credentialsFor).mockReturnValue({
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET
	});
});

describe('reading a channel', () => {
	it('mints a token with the client-credentials grant', async () => {
		const context = working();

		await twitchSourceProvider.read(source, context);

		const token = context.calls.find((call) => call.url.includes('oauth2/token'));

		expect(token?.method).toBe('POST');
		expect(token?.body).toContain('grant_type=client_credentials');
		expect(token?.body).toContain(`client_id=${CLIENT_ID}`);
	});

	it('sends the token and the client id on every Helix call', async () => {
		const context = working();

		await twitchSourceProvider.read(source, context);

		for (const call of context.calls.filter((one) => one.url.includes('helix/'))) {
			expect(call.headers.authorization).toBe('Bearer an-app-token');
			expect(call.headers['client-id']).toBe(CLIENT_ID);
		}
	});

	it('resolves the login to the numeric id every other endpoint wants', async () => {
		const context = working();

		await twitchSourceProvider.read(source, context);

		expect(context.calls.find((call) => call.url.includes('helix/users'))?.url).toContain(
			'login=someone'
		);
		expect(context.calls.find((call) => call.url.includes('helix/videos'))?.url).toContain(
			'user_id=141981764'
		);
		expect(context.calls.find((call) => call.url.includes('helix/clips'))?.url).toContain(
			'broadcaster_id=141981764'
		);
	});

	it('asks only for archived broadcasts, not every kind of video', async () => {
		// Helix's `videos` also serves highlights and uploads; `archive` is the past broadcast.
		const context = working();

		await twitchSourceProvider.read(source, context);

		expect(context.calls.find((call) => call.url.includes('helix/videos'))?.url).toContain(
			'type=archive'
		);
	});

	it('merges the videos and the clips', async () => {
		const posts = await twitchSourceProvider.read(source, working());

		expect(posts.map((post) => post.id)).toStrictEqual([
			'twitch:videos-335921245',
			'twitch:clips-AwkwardHelplessSalamanderSwiftRage'
		]);
	});

	it('prefixes the id by kind, because a video and a clip can share one', async () => {
		const context = working({
			'helix/clips': { body: { data: [{ ...CLIP, id: '335921245' }] } }
		});
		const posts = await twitchSourceProvider.read(source, context);

		expect(new Set(posts.map((post) => post.id)).size).toBe(2);
	});

	it('maps a VOD', async () => {
		const [post] = await twitchSourceProvider.read(source, working());

		expect(post).toStrictEqual({
			id: 'twitch:videos-335921245',
			source: 'twitch',
			platform: 'twitch',
			title: 'VR und Chill mit dem Otter',
			url: 'https://www.twitch.tv/videos/335921245',
			excerpt: 'A long stream about otters.',
			image: 'https://static-cdn.jtvnw.net/cf_vods/abc/thumb/thumb0-480x270.jpg',
			published_at: '2026-10-01T13:31:57.000Z',
			author: 'Someone'
		});
	});

	it('maps a clip, whose second line is who clipped it', async () => {
		// A clip has no description, so the only thing worth the line is the person who made it.
		const posts = await twitchSourceProvider.read(source, working());
		const clip = posts.find((post) => post.id.includes('clips-'));

		expect(clip?.excerpt).toBe('Clip by A Viewer');
		expect(clip?.author).toBe('Someone');
	});

	it('leaves a blank VOD description as no excerpt', async () => {
		const context = working({
			'helix/videos': { body: { data: [{ ...VIDEO, description: '   ' }] } }
		});
		const [post] = await twitchSourceProvider.read(source, context);

		expect(post?.excerpt).toBe('');
	});

	it('skips an entry with no id rather than losing the call', async () => {
		const context = working({
			'helix/videos': { body: { data: [{ ...VIDEO, id: undefined }, VIDEO] } }
		});
		const posts = await twitchSourceProvider.read(source, context);

		expect(posts.filter((post) => post.id.includes('videos-'))).toHaveLength(1);
	});

	it('is empty, not broken, for a channel that has published nothing', async () => {
		const context = working({
			'helix/videos': { body: { data: [] } },
			'helix/clips': { body: { data: [] } }
		});

		expect(await twitchSourceProvider.read(source, context)).toStrictEqual([]);
	});

	it('contributes nothing from a list it cannot parse, rather than failing the source', async () => {
		// Half an answer is better than none: a broken `clips` should not cost the VODs.
		const context = working({ 'helix/clips': { body: { data: 'not a list' } } });
		const posts = await twitchSourceProvider.read(source, context);

		expect(posts.map((post) => post.id)).toStrictEqual(['twitch:videos-335921245']);
	});
});

describe('what is cached between reads', () => {
	it('mints one token for two reads', async () => {
		const context = working();

		await twitchSourceProvider.read(source, context);
		await twitchSourceProvider.read(source, context);

		expect(context.calls.filter((call) => call.url.includes('oauth2/token'))).toHaveLength(1);
	});

	it('resolves the login once for two reads', async () => {
		const context = working();

		await twitchSourceProvider.read(source, context);
		await twitchSourceProvider.read(source, context);

		expect(context.calls.filter((call) => call.url.includes('helix/users'))).toHaveLength(1);
	});

	it('mints a new token once the stored one is older than its lifetime', async () => {
		// Ten days, the stored lifetime. A store that reports every entry as older than that must
		// make the second read pay for a token again — otherwise a revoked token would be reused
		// until the process restarted.
		const context = routing(
			{
				'oauth2/token': { body: { access_token: 'an-app-token' } },
				'helix/users': { body: { data: [{ id: '141981764' }] } },
				'helix/videos': { body: { data: [VIDEO] } },
				'helix/clips': { body: { data: [CLIP] } }
			},
			{ 'twitch-token': 10 * 24 * 60 * 60 + 1 }
		);

		await twitchSourceProvider.read(source, context);
		await twitchSourceProvider.read(source, context);

		expect(context.calls.filter((call) => call.url.includes('oauth2/token'))).toHaveLength(2);
	});

	it('resolves the login again once the stored id is older than its lifetime', async () => {
		const context = routing(
			{
				'oauth2/token': { body: { access_token: 'an-app-token' } },
				'helix/users': { body: { data: [{ id: '141981764' }] } },
				'helix/videos': { body: { data: [VIDEO] } },
				'helix/clips': { body: { data: [CLIP] } }
			},
			{ 'twitch-user': 30 * 24 * 60 * 60 + 1 }
		);

		await twitchSourceProvider.read(source, context);
		await twitchSourceProvider.read(source, context);

		expect(context.calls.filter((call) => call.url.includes('helix/users'))).toHaveLength(2);
	});

	it('does not put the client id in a cache key', async () => {
		// The key is a hash of it. A Helix error can echo a request back, and anything that reaches
		// a message should not carry the credential.
		const keys: string[] = [];
		const context = working();
		const inner = context.store;
		const watching: SourceContext = {
			fetch: (url, init) => context.fetch(url, init),
			store: {
				get: (key) => {
					keys.push(key);

					return inner.get(key);
				},
				put: (key, value) => {
					keys.push(key);

					return inner.put(key, value);
				}
			}
		};

		await twitchSourceProvider.read(source, watching);

		expect(keys.length).toBeGreaterThan(0);
		expect(keys.join(' ')).not.toContain(CLIENT_ID);
	});
});

describe('when Twitch rejects the token', () => {
	it('retries once with a fresh one', async () => {
		// Twitch answers 401 both for an expired token and a revoked one, and there is no way to
		// tell them apart in advance — so the cheap thing is to assume the stored one went bad.
		const context = working({
			'helix/users': [{ status: 401 }, { body: { data: [{ id: '141981764' }] } }]
		});
		const posts = await twitchSourceProvider.read(source, context);

		expect(context.calls.filter((call) => call.url.includes('oauth2/token'))).toHaveLength(2);
		expect(posts.length).toBeGreaterThan(0);
	});

	it('gives up after the second rejection, as a source failure', async () => {
		// An `Unauthorized` escaping to the admin would be a message about a token, which is not
		// something they can act on.
		const context = working({ 'helix/users': { status: 401 } });
		const failure = await twitchSourceProvider
			.read(source, context)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SourceFailure);
		expect(String(failure)).toMatch(/freshly issued token/);
	});

	it('does not retry a failure that is not a rejected token', async () => {
		const context = working({ 'helix/users': { status: 500 } });

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(/answered 500/);
		expect(context.calls.filter((call) => call.url.includes('oauth2/token'))).toHaveLength(1);
	});
});

describe('when a token cannot be issued', () => {
	it.each([
		['a refused client id', 401],
		['a refused secret', 403]
	])('names the two settings for %s', async (_case, status) => {
		const context = working({ 'oauth2/token': { status } });

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(
			/TWITCH_CLIENT_ID \/ TWITCH_CLIENT_SECRET/
		);
	});

	it('reports any other status without quoting the body', async () => {
		const context = working({
			'oauth2/token': { status: 500, body: { message: `secret ${CLIENT_SECRET}` } }
		});
		const failure = await twitchSourceProvider
			.read(source, context)
			.catch((error: unknown) => error);

		expect(String(failure)).toContain('(500)');
		expect(String(failure)).not.toContain(CLIENT_SECRET);
	});

	it('says so when the answer carries no token', async () => {
		const context = working({ 'oauth2/token': { body: { expires_in: 1 } } });

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(/issued no token/);
	});
});

describe('what an error message may contain', () => {
	it('never the body of a Helix error, which can echo the request', async () => {
		// Helix echoes the request on some errors, and the request carries the client id in a
		// header. This is the one reader where a careless message would leak a credential.
		const context = working({
			'helix/videos': {
				status: 400,
				body: { error: 'Bad Request', message: `client-id ${CLIENT_ID}` }
			}
		});
		const failure = await twitchSourceProvider
			.read(source, context)
			.catch((error: unknown) => error);

		expect(String(failure)).toBe('SourceFailure: Twitch answered 400.');
		expect(String(failure)).not.toContain(CLIENT_ID);
	});

	it('says plainly when a channel does not exist', async () => {
		const context = working({ 'helix/users': { body: { data: [] } } });

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(
			/no channel called someone/
		);
	});

	it('says so when Helix sends something that is not JSON', async () => {
		const context = routing({
			'oauth2/token': { body: { access_token: 'an-app-token' } },
			'helix/users': { body: undefined }
		});

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(/not JSON/);
	});
});

describe('without credentials', () => {
	beforeEach(() => {
		vi.mocked(credentialsFor).mockReturnValue({});
	});

	it('reports itself unusable, naming what to set', () => {
		expect(twitchSourceProvider.unusable(source)).toMatch(
			/TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET/
		);
	});

	it('refuses to read rather than sending an unauthenticated request', async () => {
		const context = working();

		await expect(twitchSourceProvider.read(source, context)).rejects.toThrow(/TWITCH_CLIENT_ID/);
		expect(context.calls).toStrictEqual([]);
	});

	it('is unusable with only half of them', () => {
		vi.mocked(credentialsFor).mockReturnValue({ clientId: CLIENT_ID });

		expect(twitchSourceProvider.unusable(source)).toMatch(/TWITCH_CLIENT_ID/);
	});
});

describe('the login a target names', () => {
	it.each([
		['a bare name', 'someone', 'someone'],
		['a name with an @', '@someone', 'someone'],
		['a channel url', 'https://www.twitch.tv/someone', 'someone'],
		['a url with a trailing path', 'https://www.twitch.tv/someone/videos', 'someone'],
		['a url with a trailing slash', 'https://www.twitch.tv/someone/', 'someone'],
		['mixed case, normalised', 'SomeOne', 'someone'],
		['a name with an underscore', 'some_one', 'some_one']
	])('reads %s', (_case, target, expected) => {
		expect(loginOf(target)).toBe(expected);
	});

	it.each([
		['nothing', ''],
		['two characters, below the minimum', 'ab'],
		['a name with a hyphen, which Twitch does not allow', 'some-one'],
		['a name with a dot', 'some.one'],
		['a url with no channel in it', 'https://www.twitch.tv/'],
		['a name past the maximum', 'a'.repeat(26)]
	])('refuses %s', (_case, target) => {
		expect(loginOf(target)).toBeNull();
	});

	it('refuses a source whose target is not a login', () => {
		expect(twitchSourceProvider.unusable({ ...source, target: 'some-one' })).toMatch(
			/channel’s name/
		);
	});
});

describe('a Helix thumbnail', () => {
	it('is filled in, because the raw value is a 404', () => {
		// Twitch returns these with literal `%{width}` and `%{height}` in the path.
		expect(thumbnail('https://x/thumb-%{width}x%{height}.jpg')).toBe('https://x/thumb-480x270.jpg');
	});

	it('is passed through when it is already sized, as a clip’s is', () => {
		expect(thumbnail(CLIP.thumbnail_url)).toBe(CLIP.thumbnail_url);
	});

	it('is undefined for nothing', () => {
		expect(thumbnail(undefined)).toBeUndefined();
		expect(thumbnail('')).toBeUndefined();
	});
});
