import { expect, test } from '@playwright/test';

test('has expected h1', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toBeVisible();
});

/**
 * That the published feeds are discoverable.
 *
 * A browser test rather than a unit test because the question is what is in the *served* document
 * head. `<svelte:head>` content that never reached the response would look identical in the
 * component source — and a feed nobody can discover may as well not exist, since pasting a site url
 * into a reader app works by finding exactly this element.
 */
test.describe('feed discovery', () => {
	test('advertises the Atom feed in the document head', async ({ page }) => {
		await page.goto('/');

		const link = page.locator('link[rel="alternate"][type="application/atom+xml"]');

		await expect(link).toHaveAttribute('href', '/feed.atom');
	});

	test('advertises the JSON feed too', async ({ page }) => {
		await page.goto('/');

		const link = page.locator('link[rel="alternate"][type="application/feed+json"]');

		await expect(link).toHaveAttribute('href', '/feed.json');
	});

	test('advertises Atom before JSON Feed', async ({ page }) => {
		// A reader that understands both generally takes the first, and Atom is the one everything
		// understands.
		await page.goto('/');

		const types = await page
			.locator('link[rel="alternate"][type^="application/"]')
			.evaluateAll((links) => links.map((link) => link.getAttribute('type')));

		expect(types).toStrictEqual(['application/atom+xml', 'application/feed+json']);
	});

	test('serves what the link points at', async ({ page, request }) => {
		// The link and the route agreeing is the whole point. A correct link to a missing route is
		// worse than no link, because a reader app reports it as the site's problem.
		await page.goto('/');

		const href = await page
			.locator('link[rel="alternate"][type="application/atom+xml"]')
			.getAttribute('href');

		expect(href).not.toBeNull();

		const response = await request.get(href ?? '');

		// 404 is a legitimate answer — a fresh installation has no sources configured — but it has to
		// come from the feed route refusing rather than from SvelteKit finding no route at all.
		expect([200, 404]).toContain(response.status());
		expect(response.headers()['content-type']).toMatch(/atom\+xml|text\/plain/);
	});
});
