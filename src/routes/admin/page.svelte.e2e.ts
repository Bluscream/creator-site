import { expect, test } from '@playwright/test';

/**
 * That the admin is actually closed, over HTTP, as served.
 *
 * A browser test rather than a unit test because the question is not whether `requireRole` throws —
 * `guard.test.ts` covers that — but whether the layout guard is *wired to the route*. A page added
 * under `/admin` without a server load, or a layout guard that stopped running, would leave
 * `guard.test.ts` passing and the admin open. That is the failure worth a slow test.
 *
 * Nothing here signs in. Doing so would need a Discord application, a browser at Discord and a human
 * pressing approve, which is not something a gate can run; the signed-in half of the admin is
 * covered by the unit tests underneath it. What this asserts is the half that must hold for an
 * install with nobody signed in, which is every install until somebody does.
 */
test.describe('the admin is closed', () => {
	test('sends an anonymous visitor to sign in', async ({ page }) => {
		await page.goto('/admin');

		await expect(page).toHaveURL(/\/auth\/sign-in/);
	});

	test('remembers where they were going', async ({ page }) => {
		// Somebody who follows a link deep into the admin should land there once they are in, rather
		// than on a dashboard having forgotten what they came for.
		await page.goto('/admin?tab=links');

		expect(new URL(page.url()).searchParams.get('next')).toBe('/admin?tab=links');
	});

	test('renders no admin content on the way past', async ({ page }) => {
		// A redirect that still streamed the page first would be a guard in name only.
		const response = await page.goto('/admin');

		expect(await page.locator('form[action="/auth/sign-out"]').count()).toBe(0);
		expect(response?.status()).toBe(200);
	});

	test('keeps itself out of search results', async ({ page }) => {
		await page.goto('/admin');

		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
	});
});

test.describe('the sign-in page', () => {
	test('says so when no provider is configured', async ({ page }) => {
		// The state a fresh install is in, and the one a self-hoster is most likely to see first. A page
		// of no buttons would read as broken rather than as unconfigured.
		await page.goto('/auth/sign-in');

		await expect(page.locator('h1')).toBeVisible();
	});

	test('offers no sign-in method on an unconfigured install', async ({ page }) => {
		// The test environment has no Discord application, so this asserts the unconfigured branch.
		// With credentials present the page would show a button instead, which `sign-in-registry.test.ts`
		// covers.
		await page.goto('/auth/sign-in');

		expect(await page.locator('a.provider').count()).toBe(0);
	});

	test('refuses a sign-in method nobody has', async ({ request }) => {
		const response = await request.get('/auth/myspace/login', { maxRedirects: 0 });

		expect(response.status()).toBe(404);
	});

	test('refuses a sign-out on GET', async ({ request }) => {
		// A sign-out on `GET` can be fired by an `<img>` on another site or an over-eager prefetcher,
		// and the creator would be signed out over and over with no way to tell why.
		const response = await request.get('/auth/sign-out', { maxRedirects: 0 });

		expect(response.status()).toBe(405);
	});

	test('keeps itself out of search results too', async ({ page }) => {
		await page.goto('/auth/sign-in');

		await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
	});
});

/**
 * That the new admin pages are behind the same guard, as served.
 *
 * Each one is its own route with its own server file, and the whole point of putting the guard in
 * the layout is that adding a page does not mean remembering to protect it. These assert that is
 * actually what happens, which is the one thing the unit tests cannot see.
 */
test.describe('every admin page is closed', () => {
	/**
	 * Each admin route, with an action to post to.
	 *
	 * The action name matters: SvelteKit answers 404 to a bare `POST` at a route whose actions are all
	 * named, before any route code runs. A test satisfied by that would pass with no guard at all.
	 */
	const routes = [
		{ path: '/admin', action: '' },
		{ path: '/admin/account', action: '?/endOthers' },
		{ path: '/admin/people', action: '' },
		{ path: '/admin/backup', action: '?/inspect' }
	];

	test('refuses a backup download to nobody, without writing one', async ({ baseURL, request }) => {
		// Not in the table above: it is a standalone `POST`-only route rather than a page with
		// actions, so there is no page to be redirected away from — and it is the one endpoint here
		// whose success would hand an anonymous caller a copy of the entire database.
		const response = await request.post('/admin/backup/archive', {
			headers: { origin: baseURL ?? '' },
			form: { password: 'a password long enough' },
			maxRedirects: 0
		});

		expect([401, 403]).toContain(response.status());

		// And nothing that looks like an archive came back, which is the claim that matters: a guard
		// that refuses with the right status while still streaming the file would pass on status
		// alone.
		expect(response.headers()['content-disposition']).toBeUndefined();
	});

	for (const { path, action } of routes) {
		test(`sends an anonymous visitor away from ${path}`, async ({ page }) => {
			await page.goto(path);

			await expect(page).toHaveURL(/\/auth\/sign-in/);
		});

		test(`refuses a form POST to ${path} from nobody`, async ({ baseURL, request }) => {
			// The guard has to hold for the actions as well as for the page. A load-only check would
			// leave a writable endpoint behind a locked page.
			//
			// The `origin` header is sent deliberately. Without it SvelteKit refuses the request as
			// cross-site with a 403 before any route code runs — which is a refusal, but not the one
			// under test.
			const response = await request.post(`${path}${action}`, {
				headers: { origin: baseURL ?? '' },
				form: { userId: 'somebody', role: 'owner' },
				maxRedirects: 0
			});

			// The refusal arrives in one of two shapes and both are correct. A plain form submission gets
			// a 303; a request SvelteKit treats as programmatic — which this one is, because of the
			// `origin` header — gets HTTP 200 carrying a serialised action result that *says* redirect.
			// So the assertion is on what the body says, not on the status line.
			if (response.status() === 303 || response.status() === 405) return;

			expect(response.status()).toBe(200);
			expect(await response.json()).toMatchObject({ type: 'redirect', status: 303 });
		});
	}
});
