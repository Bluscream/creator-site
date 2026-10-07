/**
 * That an ordinary feed becomes posts, whichever of the four formats it is.
 *
 * The fixtures are written the way real feeds are rather than the way the mapper reads them: an
 * RSS item with its thumbnail in an enclosure, a YouTube Atom entry with its description in the
 * media namespace, an RDF item with its date in Dublin Core. A fixture shaped after the code would
 * pass against a mapper reading the wrong field.
 */

import { describe, expect, it } from 'vitest';
import { feedSourceProvider } from './feed-source.js';
import type { ResolvedSource } from './post.js';
import { SourceFailure } from './posts-source.js';
import type { SourceContext } from './posts-source.js';

const source: ResolvedSource = {
	id: 'blog',
	kind: 'feed',
	target: 'https://example.com/feed.xml',
	label: 'Blog',
	platform: null
};

/** A context whose fetch answers with a fixed body, so nothing leaves the process. */
function serving(
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {}
): SourceContext {
	return {
		fetch: () =>
			Promise.resolve(
				new Response(body, {
					status: init.status ?? 200,
					headers: init.headers ?? { 'content-type': 'application/xml' }
				})
			)
	};
}

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
	<title>Blog</title><link>https://example.com</link>
	<item>
		<title>Hello &amp; welcome</title>
		<link>https://example.com/a</link>
		<guid>abc-1</guid>
		<pubDate>Mon, 06 Oct 2026 11:34:44 GMT</pubDate>
		<description>&lt;p&gt;Body &lt;b&gt;here&lt;/b&gt;&lt;/p&gt;</description>
		<enclosure url="https://example.com/t.jpg" type="image/jpeg" length="1"/>
	</item>
</channel></rss>`;

/** A YouTube channel feed, which is what the `youtube` kind reduces to. */
const youtubeAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
	<title>Someone</title>
	<entry>
		<id>yt:video:nCGniMcYpyM</id>
		<yt:videoId>nCGniMcYpyM</yt:videoId>
		<title>VR und Chill</title>
		<link rel="alternate" href="https://www.youtube.com/watch?v=nCGniMcYpyM"/>
		<author><name>Someone</name></author>
		<published>2026-10-06T11:34:44+00:00</published>
		<updated>2026-10-06T12:00:00+00:00</updated>
		<media:group>
			<media:thumbnail url="https://i3.ytimg.com/vi/nCGniMcYpyM/hqdefault.jpg" width="480" height="360"/>
			<media:description>Welcome to the Otterspace</media:description>
		</media:group>
	</entry>
</feed>`;

const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
	<channel rdf:about="https://example.com"><title>R</title><link>https://example.com</link><description>d</description></channel>
	<item rdf:about="https://example.com/r1">
		<title>RDF post</title>
		<link>https://example.com/r1</link>
		<description>Body</description>
		<dc:date>2026-10-03T00:00:00Z</dc:date>
		<dc:creator>Writer</dc:creator>
	</item>
</rdf:RDF>`;

const jsonFeed = JSON.stringify({
	version: 'https://jsonfeed.org/version/1.1',
	title: 'J',
	items: [
		{
			id: 'j-1',
			url: 'https://example.com/j',
			title: 'JSON post',
			content_text: 'body',
			date_published: '2026-10-02T00:00:00Z',
			image: 'https://example.com/j.jpg',
			authors: [{ name: 'Au' }]
		}
	]
});

describe('an RSS feed', () => {
	it('becomes a post with every field mapped', async () => {
		const [post] = await feedSourceProvider.read(source, serving(rss));

		expect(post).toStrictEqual({
			id: 'blog:abc-1',
			source: 'blog',
			platform: null,
			title: 'Hello & welcome',
			url: 'https://example.com/a',
			excerpt: 'Body here',
			image: 'https://example.com/t.jpg',
			published_at: '2026-10-06T11:34:44.000Z',
			author: null
		});
	});

	it('takes the thumbnail from an image enclosure', async () => {
		const [post] = await feedSourceProvider.read(source, serving(rss));

		expect(post?.image).toBe('https://example.com/t.jpg');
	});

	it('ignores an enclosure that is not an image', async () => {
		// A podcast feed encloses the audio. Using it as a thumbnail would put an mp3 in an image.
		const audio = rss.replace('type="image/jpeg"', 'type="audio/mpeg"');
		const [post] = await feedSourceProvider.read(source, serving(audio));

		expect(post?.image).toBeNull();
	});

	it('falls back to the link when there is no guid', async () => {
		const [post] = await feedSourceProvider.read(
			source,
			serving(rss.replace('<guid>abc-1</guid>', ''))
		);

		expect(post?.id).toBe('blog:https://example.com/a');
	});
});

describe('a YouTube Atom feed', () => {
	it('reads the thumbnail and description out of the media namespace', async () => {
		// The reason the parser had to expose namespaces at all: a YouTube entry has no `summary`
		// and no enclosure, so both of these are only reachable through `media:group`.
		const [post] = await feedSourceProvider.read({ ...source, id: 'yt' }, serving(youtubeAtom));

		expect(post).toMatchObject({
			title: 'VR und Chill',
			url: 'https://www.youtube.com/watch?v=nCGniMcYpyM',
			excerpt: 'Welcome to the Otterspace',
			image: 'https://i3.ytimg.com/vi/nCGniMcYpyM/hqdefault.jpg',
			author: 'Someone'
		});
	});

	it('prefers published over updated', async () => {
		// A video edited later must not jump to the top of a chronological feed.
		const [post] = await feedSourceProvider.read(source, serving(youtubeAtom));

		expect(post?.published_at).toBe('2026-10-06T11:34:44.000Z');
	});

	it('uses updated when that is the only date', async () => {
		const noPublished = youtubeAtom.replace(/<published>.*<\/published>/, '');
		const [post] = await feedSourceProvider.read(source, serving(noPublished));

		expect(post?.published_at).toBe('2026-10-06T12:00:00.000Z');
	});

	it('prefers the author summary over the full content', async () => {
		const withBoth = `<?xml version="1.0"?>
			<feed xmlns="http://www.w3.org/2005/Atom"><entry>
				<id>x</id><title>T</title>
				<link rel="alternate" href="https://example.com/x"/>
				<summary>The short one</summary>
				<content>The entire article, which would make a worse excerpt</content>
			</entry></feed>`;
		const [post] = await feedSourceProvider.read(source, serving(withBoth));

		expect(post?.excerpt).toBe('The short one');
	});

	it('treats a link with no rel as the alternate, which Atom says it is', async () => {
		const noRel = `<?xml version="1.0"?>
			<feed xmlns="http://www.w3.org/2005/Atom"><entry>
				<id>x</id><title>T</title><link href="https://example.com/x"/>
			</entry></feed>`;
		const [post] = await feedSourceProvider.read(source, serving(noRel));

		expect(post?.url).toBe('https://example.com/x');
	});
});

describe('an RDF feed', () => {
	it('reads the date and author out of Dublin Core', async () => {
		const [post] = await feedSourceProvider.read(source, serving(rdf));

		expect(post).toMatchObject({
			id: 'blog:https://example.com/r1',
			title: 'RDF post',
			url: 'https://example.com/r1',
			published_at: '2026-10-03T00:00:00.000Z',
			author: 'Writer'
		});
	});
});

describe('a JSON feed', () => {
	it('becomes a post', async () => {
		const [post] = await feedSourceProvider.read(source, serving(jsonFeed));

		expect(post).toMatchObject({
			id: 'blog:j-1',
			title: 'JSON post',
			url: 'https://example.com/j',
			excerpt: 'body',
			image: 'https://example.com/j.jpg',
			author: 'Au'
		});
	});
});

describe('a feed with nothing in it', () => {
	it('is an empty list, not a failure', async () => {
		// An account that has posted nothing is not an error.
		const empty =
			'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://e.test</link></channel></rss>';

		await expect(feedSourceProvider.read(source, serving(empty))).resolves.toStrictEqual([]);
	});
});

describe('a source that cannot be read', () => {
	it('reports the status, because a 404 and a 403 mean different things', async () => {
		await expect(feedSourceProvider.read(source, serving('nope', { status: 404 }))).rejects.toThrow(
			/answered 404/
		);
	});

	it('says so when the url did not return a feed at all', async () => {
		// How a broken bridge usually fails: 200, with an HTML error page.
		await expect(
			feedSourceProvider.read(source, serving('<html><body>Error</body></html>'))
		).rejects.toBeInstanceOf(SourceFailure);
	});

	it('refuses a body that claims to be enormous without reading it', async () => {
		await expect(
			feedSourceProvider.read(
				source,
				serving(rss, { headers: { 'content-length': String(64 * 1024 * 1024) } })
			)
		).rejects.toThrow(/too large/);
	});
});

describe('deciding whether a source is usable at all', () => {
	it('accepts an http and an https url', () => {
		expect(feedSourceProvider.unusable(source)).toBeNull();
		expect(feedSourceProvider.unusable({ ...source, target: 'http://example.com/f' })).toBeNull();
	});

	it('refuses something that is not a url, without making a request', () => {
		expect(feedSourceProvider.unusable({ ...source, target: '@someone' })).toMatch(/not a URL/);
	});

	it.each(['file:///etc/passwd', 'data:text/xml,<rss/>', 'ftp://example.com/f'])(
		'refuses %s, which is not something a feed reader should open',
		(target) => {
			// A target comes from a configuration file. Left unchecked, `file:` would turn a feed
			// reader into a way to read the server's own disk.
			expect(feedSourceProvider.unusable({ ...source, target })).toMatch(/http or https/);
		}
	);
});
