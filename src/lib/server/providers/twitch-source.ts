/**
 * Twitch VODs and clips, through the official Helix API.
 *
 * The one platform here with a real, free, documented API that does not need the channel owner to
 * sign in. `Get Videos` and `Get Clips` are both satisfied by an **app access token** — the
 * client-credentials grant, two ids and no user OAuth, no redirect, no refresh dance. That is what
 * makes it worth a reader of its own rather than a bridge: a bridge scrapes a page that changes,
 * this reads a contract Twitch publishes.
 *
 * ### Configuration
 *
 * `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`, from an application registered at
 * <https://dev.twitch.tv/console/apps>. The redirect url it asks for is never used by this grant;
 * `http://localhost` is fine. Both come through {@link credentialsFor}, so when the admin can store
 * a creator's own credentials this reader does not change. Until both are set the source reports
 * itself unusable and the feed carries on without it, which is why adding the source before the
 * credentials is harmless.
 *
 * ### Three requests on a cold cache, one when warm
 *
 * The app token lasts about sixty days and a broadcaster's numeric id never changes, so both are
 * stored and the usual refresh is a single pair of calls for the videos and clips. The token is kept
 * well short of its real lifetime because Twitch can revoke one early — and a 401 re-mints it once
 * regardless, so the stored lifetime only decides how often the happy path pays for a token.
 *
 * ### Nothing from an error body is ever repeated
 *
 * A Helix error can echo the request back, and the request carries the client id in a header. So a
 * failure here reports the status and never the body, and a refused token says which two settings
 * are wrong without quoting either. This is the one reader where a careless error message would
 * leak a credential.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContentPiece } from '../../posts.js';
import { credentialsFor } from './credentials.js';
import { buildPost } from './post.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { PostsSourceProvider, SourceContext } from './posts-source.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API = 'https://api.twitch.tv/helix/';

/**
 * How long an app token is reused.
 *
 * Twitch issues these for roughly sixty days; this keeps one for ten. The gap is deliberate — a
 * token can be revoked early and {@link read} retries a 401 with a fresh one either way, so this
 * only decides how often the happy path pays for a token request.
 */
const TOKEN_TTL = 10 * 24 * 60 * 60;

/** A broadcaster's numeric id, which never changes. */
const USER_TTL = 30 * 24 * 60 * 60;

/** How many of each to ask for. More than a row shows, so the sort has something to do. */
const PER_KIND = 20;

/** Twitch's thumbnails carry these placeholders rather than a size. */
const THUMB_WIDTH = '480';
const THUMB_HEIGHT = '270';

/** Twitch logins are 3–25 of these characters. */
const LOGIN = /^[A-Za-z0-9_]{3,25}$/;

const NO_CREDENTIALS = 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to read Twitch.';
const ADVICE = 'Use the channel’s name, or a link to it.';

/**
 * A rejected token, as distinct from any other failure.
 *
 * Its own class so {@link read} can retry exactly this case once. Not a {@link SourceFailure},
 * because a caller that let one of these out would be reporting "Twitch rejected the token" to an
 * admin who can do nothing about it — the retry is what the admin would want done.
 */
class Unauthorized extends Error {}

/** Each Helix list, as far as the fields a post needs. */
const listSchema = z.object({
	data: z
		.array(
			z
				.object({
					id: z.string().optional(),
					url: z.string().optional(),
					title: z.string().optional(),
					description: z.string().optional(),
					creator_name: z.string().optional(),
					broadcaster_name: z.string().optional(),
					user_name: z.string().optional(),
					thumbnail_url: z.string().optional(),
					created_at: z.string().optional()
				})
				.loose()
		)
		.optional()
});

/** One Helix entry. */
type Entry = NonNullable<z.output<typeof listSchema>['data']>[number];

const usersSchema = z.object({
	data: z.array(z.object({ id: z.string().optional() }).loose()).optional()
});

const tokenSchema = z.object({ access_token: z.string().optional() });

/** The channel's login name out of whatever the configuration says, or null. */
export function loginOf(target: string): string | null {
	let value = target.trim();

	if (/^https?:\/\//i.test(value)) {
		let path: string;

		try {
			path = new URL(value).pathname;
		} catch {
			return null;
		}

		// The first non-empty segment, so a trailing slash or a `/videos` suffix does not matter.
		value = path.split('/').find((segment) => segment !== '') ?? '';
	}

	value = value.replace(/^@/, '');

	return LOGIN.test(value) ? value.toLowerCase() : null;
}

/**
 * A Helix thumbnail at a real size.
 *
 * Twitch returns these with `%{width}` and `%{height}` literals in the path, so the raw value is a
 * 404 until they are filled in. A clip's url uses a different spelling again — `-preview-480x272.jpg`
 * is already sized — so anything without the placeholders is passed through untouched.
 */
export function thumbnail(url: string | undefined): string | undefined {
	if (url === undefined || url === '') return undefined;

	return url.replaceAll('%{width}', THUMB_WIDTH).replaceAll('%{height}', THUMB_HEIGHT);
}

/** Where a credential's cached derivatives live, without the credential appearing in the key. */
function namespace(clientId: string): string {
	// Hashed so rotating the application does not serve a token minted for the old one, and so the
	// client id is not written into a cache key that an error message might one day include.
	return createHash('sha256').update(clientId).digest('hex').slice(0, 32);
}

/** One Helix GET, parsed. Throws {@link Unauthorized} for a 401 so the caller can retry once. */
async function call(
	path: string,
	token: string,
	clientId: string,
	context: SourceContext
): Promise<unknown> {
	const response = await context.fetch(`${API}${path}`, {
		headers: { authorization: `Bearer ${token}`, 'client-id': clientId }
	});

	if (response.status === 401) throw new Unauthorized('Twitch rejected the token.');

	// The status, never the body: a Helix error can echo the request, and the request carried the
	// client id in a header.
	if (!response.ok) throw new SourceFailure(`Twitch answered ${String(response.status)}.`);

	try {
		return await response.json();
	} catch {
		throw new SourceFailure('Twitch sent something that was not JSON.');
	}
}

/** An app access token, from the store unless `fresh`. */
async function appToken(
	clientId: string,
	clientSecret: string,
	context: SourceContext,
	fresh: boolean
): Promise<string> {
	const key = `twitch-token\0${namespace(clientId)}`;

	if (!fresh) {
		const stored = await context.store.get(key);

		if (stored !== null && stored.age < TOKEN_TTL) return stored.value;
	}

	const response = await context.fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'client_credentials'
		}).toString()
	});

	if (!response.ok) {
		// Neither the body nor the status alone: a 401 or 403 here means a setting is wrong, and
		// that is the useful thing to say without quoting anything back.
		throw new SourceFailure(
			response.status === 401 || response.status === 403
				? 'Twitch rejected TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.'
				: `Twitch would not issue a token (${String(response.status)}).`
		);
	}

	const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
	const token = parsed.success ? parsed.data.access_token : undefined;

	if (token === undefined || token === '') throw new SourceFailure('Twitch issued no token.');

	// A bearer token at rest in the server's own cache, which is where the PHP this replaces kept
	// it too. It is short-lived, server-side only, and never logged or returned.
	await context.store.put(key, token);

	return token;
}

/** The broadcaster's numeric id, which is what every other endpoint wants. */
async function userId(
	login: string,
	token: string,
	clientId: string,
	context: SourceContext
): Promise<string> {
	const key = `twitch-user\0${login}`;
	const stored = await context.store.get(key);

	if (stored !== null && stored.age < USER_TTL) return stored.value;

	const body = await call(
		`users?${new URLSearchParams({ login }).toString()}`,
		token,
		clientId,
		context
	);
	const parsed = usersSchema.safeParse(body);
	const id = parsed.success ? parsed.data.data?.[0]?.id : undefined;

	if (id === undefined || id === '') {
		throw new SourceFailure(`Twitch has no channel called ${login}.`);
	}

	await context.store.put(key, id);

	return id;
}

/**
 * The videos and the clips, fetched together and merged.
 *
 * Both at once because they are two halves of the same question — what has this channel put out —
 * and running them concurrently costs the same wall clock as either alone.
 */
async function fetchPosts(
	source: ResolvedSource,
	login: string,
	token: string,
	clientId: string,
	context: SourceContext
): Promise<readonly ContentPiece[]> {
	const id = await userId(login, token, clientId, context);
	const first = String(PER_KIND);

	const [videos, clips] = await Promise.all([
		call(
			`videos?${new URLSearchParams({ first, user_id: id, type: 'archive' }).toString()}`,
			token,
			clientId,
			context
		),
		call(
			`clips?${new URLSearchParams({ first, broadcaster_id: id }).toString()}`,
			token,
			clientId,
			context
		)
	]);

	return [...entriesOf(videos, 'videos', source), ...entriesOf(clips, 'clips', source)];
}

/** One Helix list as posts. A list that will not parse contributes nothing rather than throwing. */
function entriesOf(
	body: unknown,
	kind: 'videos' | 'clips',
	source: ResolvedSource
): readonly ContentPiece[] {
	const parsed = listSchema.safeParse(body);

	if (!parsed.success) return [];

	return (parsed.data.data ?? [])
		.map((entry) => toPost(entry, kind, source))
		.filter((post): post is ContentPiece => post !== null);
}

/** One entry as a post, or null when it is not one. */
function toPost(
	entry: Entry,
	kind: 'videos' | 'clips',
	source: ResolvedSource
): ContentPiece | null {
	const id = entry.id;

	if (id === undefined || id === '') return null;

	return buildPost(source, {
		// Prefixed by kind, because a video and a clip can hold the same numeric id.
		id: `${kind}-${id}`,
		// "VOD" and "clip" are words a viewer understands; "post" is what neither of them is. One
		// reader returns both, which is the whole reason the canonical kind is per piece.
		kind: kind === 'videos' ? 'vod' : 'clip',
		url: entry.url,
		title: entry.title,
		excerpt: describe(entry, kind),
		image: thumbnail(entry.thumbnail_url),
		publishedAt: entry.created_at,
		author: entry.broadcaster_name ?? entry.user_name
	});
}

/** The second line of a row. A VOD has a description; a clip has none. */
function describe(entry: Entry, kind: 'videos' | 'clips'): string | undefined {
	if (kind === 'videos') {
		return entry.description !== undefined && entry.description.trim() !== ''
			? entry.description
			: undefined;
	}

	// For a clip the person who clipped it is the only thing worth the line. Not translated, which
	// is a known wart: it is the one piece of English a provider still produces, and moving it
	// behind the message catalogue means giving a provider access to the request's locale.
	return entry.creator_name === undefined ? undefined : `Clip by ${entry.creator_name}`;
}

export const twitchSourceProvider: PostsSourceProvider = {
	unusable(source: ResolvedSource): string | null {
		const { clientId, clientSecret } = credentialsFor('twitch');

		if (clientId === undefined || clientSecret === undefined) return NO_CREDENTIALS;

		return loginOf(source.target) === null ? ADVICE : null;
	},

	async read(source: ResolvedSource, context: SourceContext): Promise<readonly ContentPiece[]> {
		const { clientId, clientSecret } = credentialsFor('twitch');

		if (clientId === undefined || clientSecret === undefined) {
			throw new SourceFailure(NO_CREDENTIALS);
		}

		const login = loginOf(source.target);

		if (login === null) throw new SourceFailure(ADVICE);

		try {
			const token = await appToken(clientId, clientSecret, context, false);

			return await fetchPosts(source, login, token, clientId, context);
		} catch (error) {
			if (!(error instanceof Unauthorized)) throw error;

			// One retry, with a freshly minted token. Twitch answers 401 both for an expired token
			// and for a revoked one and there is no way to tell them apart in advance, so assuming
			// the stored token went bad is cheaper than validating it on every refresh.
			const token = await appToken(clientId, clientSecret, context, true);

			try {
				return await fetchPosts(source, login, token, clientId, context);
			} catch (retried) {
				// A second 401 is not a stale token. Re-thrown as a source failure, because an
				// `Unauthorized` escaping here would reach the admin as a message about a token
				// rather than about the credentials that are actually wrong.
				if (retried instanceof Unauthorized) {
					throw new SourceFailure('Twitch rejected a freshly issued token.');
				}

				throw retried;
			}
		}
	}
};
