/**
 * That a Bluesky author feed becomes posts.
 *
 * The response fixture is shaped after a real one from `public.api.bsky.app`, including the parts
 * this does not read — an `at://` uri that is useless to a browser, a `recordWithMedia` embed, a
 * post whose only picture is a link card's preview.
 */

import { describe, expect, it } from 'vitest';
import { blueskySourceProvider, handleOf } from './bluesky-source.js';
import { memoryStore } from '#lib/server/fixtures/source-context.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { SourceContext } from './posts-source.js';

const source: ResolvedSource = {
	id: 'bluesky',
	kind: 'bluesky',
	target: 'someone.bsky.social',
	label: 'Bluesky',
	platform: 'bluesky'
};

/** A context answering with a JSON body, recording the urls asked for. */
function answering(body: unknown, status = 200): SourceContext & { readonly urls: string[] } {
	const urls: string[] = [];

	return {
		urls,
		store: memoryStore(),
		fetch: (url: string) => {
			urls.push(url);

			return Promise.resolve(
				new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				})
			);
		}
	};
}

/** One feed entry, with the fields the AppView actually sends. */
function entry(overrides: Record<string, unknown> = {}) {
	return {
		post: {
			uri: 'at://did:plc:abc123/app.bsky.feed.post/3kabcdef',
			cid: 'bafyreiabc',
			author: { handle: 'someone.bsky.social', displayName: 'Someone' },
			record: {
				$type: 'app.bsky.feed.post',
				text: 'A post about otters\nwith a second line',
				createdAt: '2026-10-05T10:00:00.000Z'
			},
			replyCount: 2,
			likeCount: 9,
			...overrides
		}
	};
}

describe('reading an author feed', () => {
	it('asks only for the account’s own posts', async () => {
		// A reply to a stranger reads as noise beside an upload, so replies are filtered server-side
		// rather than after the fact. Reposts cannot be — see the test below.
		const context = answering({ feed: [] });

		await blueskySourceProvider.read(source, context);

		const url = new URL(context.urls[0] ?? '');

		expect(url.searchParams.get('actor')).toBe('someone.bsky.social');
		expect(url.searchParams.get('filter')).toBe('posts_no_replies');
	});

	it('builds a web url, because an at:// uri is not something a browser opens', async () => {
		const context = answering({ feed: [entry()] });
		const [post] = await blueskySourceProvider.read(source, context);

		expect(post?.url).toBe('https://bsky.app/profile/someone.bsky.social/post/3kabcdef');
	});

	it('maps the rest of the post', async () => {
		const [post] = await blueskySourceProvider.read(source, answering({ feed: [entry()] }));

		expect(post).toStrictEqual({
			id: 'bluesky:bafyreiabc',
			source: 'bluesky',
			platform: 'bluesky',
			// The first line stands in for a title, and the whole text is still the excerpt —
			// otherwise every row would be headed by its own body.
			title: 'A post about otters',
			url: 'https://bsky.app/profile/someone.bsky.social/post/3kabcdef',
			excerpt: 'A post about otters with a second line',
			image: null,
			published_at: '2026-10-05T10:00:00.000Z',
			author: 'Someone'
		});
	});

	it('falls back to the handle when there is no display name', async () => {
		const [post] = await blueskySourceProvider.read(
			source,
			answering({
				feed: [entry({ author: { handle: 'someone.bsky.social', displayName: '' } })]
			})
		);

		expect(post?.author).toBe('someone.bsky.social');
	});

	it('leaves the title empty for a post with no text, rather than inventing one', async () => {
		// The PHP this replaces used the literal string 'Post' here. An English noun inside a
		// provider is a string no translation could reach, and an empty title is documented as
		// rendering from the excerpt.
		const [post] = await blueskySourceProvider.read(
			source,
			answering({ feed: [entry({ record: { text: '', createdAt: '2026-10-05T10:00:00.000Z' } })] })
		);

		expect(post?.title).toBe('');
	});

	it('skips an entry with no author, rather than losing the whole fetch', async () => {
		const context = answering({
			feed: [entry({ author: undefined }), entry({ cid: 'bafyreidef' })]
		});
		const posts = await blueskySourceProvider.read(source, context);

		expect(posts.map((post) => post.id)).toStrictEqual(['bluesky:bafyreidef']);
	});

	it('drops a repost, which is somebody else’s post', async () => {
		// Not hypothetical: asked for a live account with `filter=posts_no_replies`, the newest entry
		// the AppView returned was a repost, and its `post.author` was the original author — so left
		// in, this creator's feed shows a stranger's name linking to a stranger's profile.
		const context = answering({
			feed: [
				{
					reason: {
						$type: 'app.bsky.feed.defs#reasonRepost',
						by: { handle: 'someone.bsky.social' },
						indexedAt: '2026-10-06T17:59:10.671Z'
					},
					post: {
						...entry().post,
						cid: 'bafyreirepost',
						author: { handle: 'stranger.example.com', displayName: 'A Stranger' }
					}
				},
				entry()
			]
		});
		const posts = await blueskySourceProvider.read(source, context);

		expect(posts.map((post) => post.author)).toStrictEqual(['Someone']);
	});

	it('tolerates fields the AppView adds without notice', async () => {
		// Rejecting an unknown field would make every addition upstream a breakage here.
		const [post] = await blueskySourceProvider.read(
			source,
			answering({ feed: [entry({ somethingNew: { nested: true } })], cursor: 'abc' })
		);

		expect(post?.id).toBe('bluesky:bafyreiabc');
	});
});

describe('the picture on a post', () => {
	it('is the first attached image', async () => {
		const [post] = await blueskySourceProvider.read(
			source,
			answering({
				feed: [
					entry({
						embed: {
							$type: 'app.bsky.embed.images#view',
							images: [{ thumb: 'https://cdn.bsky.app/one.jpg' }, { thumb: 'https://x/two.jpg' }]
						}
					})
				]
			})
		);

		expect(post?.image).toBe('https://cdn.bsky.app/one.jpg');
	});

	it('is a link card’s preview when that is the only picture', async () => {
		const [post] = await blueskySourceProvider.read(
			source,
			answering({
				feed: [
					entry({
						embed: {
							$type: 'app.bsky.embed.external#view',
							external: { uri: 'https://example.com', thumb: 'https://cdn.bsky.app/card.jpg' }
						}
					})
				]
			})
		);

		expect(post?.image).toBe('https://cdn.bsky.app/card.jpg');
	});

	it('is found one level down, where a quote-post nests its own media', async () => {
		const [post] = await blueskySourceProvider.read(
			source,
			answering({
				feed: [
					entry({
						embed: {
							$type: 'app.bsky.embed.recordWithMedia#view',
							record: { $type: 'app.bsky.embed.record#view' },
							media: {
								$type: 'app.bsky.embed.images#view',
								images: [{ thumb: 'https://cdn.bsky.app/nested.jpg' }]
							}
						}
					})
				]
			})
		);

		expect(post?.image).toBe('https://cdn.bsky.app/nested.jpg');
	});

	it('is null for an embed that carries no picture at all', async () => {
		const [post] = await blueskySourceProvider.read(
			source,
			answering({
				feed: [entry({ embed: { $type: 'app.bsky.embed.record#view', record: { uri: 'at://x' } } })]
			})
		);

		expect(post?.image).toBeNull();
	});
});

describe('the handle a target names', () => {
	it.each([
		['a bare handle', 'someone.bsky.social', 'someone.bsky.social'],
		['a handle with an @', '@someone.bsky.social', 'someone.bsky.social'],
		['a profile url', 'https://bsky.app/profile/someone.bsky.social', 'someone.bsky.social'],
		[
			'a profile url with a trailing path',
			'https://bsky.app/profile/someone.bsky.social/post/3k',
			'someone.bsky.social'
		],
		['mixed case, normalised', 'SomeOne.BSky.Social', 'someone.bsky.social'],
		// The scheme's whole point: a handle is a domain, and any domain can be one.
		['a custom domain', 'example.com', 'example.com']
	])('reads %s', (_case, target, expected) => {
		expect(handleOf(target)).toBe(expected);
	});

	it.each([
		['nothing', ''],
		['a name with no dot in it, which is not a domain', 'someone'],
		['a url that is not a profile', 'https://bsky.app/'],
		['a handle with a space', 'some one.bsky.social'],
		['a handle starting with a dot', '.bsky.social'],
		['a handle with an underscore, which a domain cannot have', 'some_one.bsky.social']
	])('refuses %s', (_case, target) => {
		expect(handleOf(target)).toBeNull();
	});
});

describe('when Bluesky refuses', () => {
	it('says plainly that no such account exists', async () => {
		// A 400 is what the AppView answers for a handle nobody holds, and it is the one failure
		// here an admin can actually fix.
		await expect(
			blueskySourceProvider.read(source, answering({ error: 'InvalidRequest' }, 400))
		).rejects.toThrow(/no account called someone.bsky.social/);
	});

	it('reports any other status', async () => {
		await expect(
			blueskySourceProvider.read(source, answering({ error: 'Oops' }, 503))
		).rejects.toThrow(/answered 503/);
	});

	it('says so when the body is not what it should be', async () => {
		await expect(
			blueskySourceProvider.read(source, answering({ feed: 'not a list' }))
		).rejects.toBeInstanceOf(SourceFailure);
	});
});

describe('deciding whether a source is usable', () => {
	it('accepts a handle', () => {
		expect(blueskySourceProvider.unusable(source)).toBeNull();
	});

	it('shows the shape of a handle rather than only refusing', () => {
		expect(blueskySourceProvider.unusable({ ...source, target: 'someone' })).toMatch(
			/name\.bsky\.social/
		);
	});
});
