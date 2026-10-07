/**
 * The chat page, in a real browser.
 *
 * The unit tests cover the settings parser and the merge; this covers the thing neither can — that
 * a message actually reaches the screen. Every piece between the response and the pixels is Svelte
 * markup, and the failure mode there is a row that renders empty or not at all, which no amount of
 * testing the data shape would catch.
 *
 * ### The responses are stubbed, and that is the point
 *
 * `page.route` answers `/api/chat` and `/api/activity` with fixed bodies, so these tests need no
 * Synchra account, no token and no live channel — they run in CI and on a fresh clone. What they
 * assert is this project's rendering of a known payload, which is exactly the half that belongs to
 * this project.
 *
 * `/api/events` is stubbed as an empty stream that stays open. Without that the page's
 * `EventSource` would hit the real endpoint, and in a build with no provider configured it would
 * connect and sit silent — harmless, but it would hold the test's browser context open.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const MESSAGE = {
	id: 'm1',
	platform: 'twitch',
	source: null,
	at: '2026-10-06T13:00:00+00:00',
	author: { name: 'Ada', colour: '#1f8fff', profileUrl: 'https://www.twitch.tv/ada' },
	text: 'first message',
	parts: [{ kind: 'text', text: 'first message' }],
	notice: null
};

const NOTICE = {
	...MESSAGE,
	id: 'm2',
	platform: 'tiktok',
	at: '2026-10-06T13:00:01+00:00',
	author: { name: 'Linus' },
	text: 'sent Rose',
	parts: [
		{ kind: 'text', text: 'sent ' },
		{ kind: 'gift', text: 'Rose' }
	],
	notice: 'tiktok_gift'
};

const DONATION = {
	id: 'a1',
	platform: 'twitch',
	source: null,
	at: '2026-10-06T13:00:02+00:00',
	type: 'charity_donation',
	type_label: 'Donation',
	group: 'donation',
	actor: { name: 'Grace' },
	amount: 5,
	currency: 'EUR',
	count_name: 'euro',
	message: 'keep it up',
	message_parts: [{ kind: 'text', text: 'keep it up' }],
	system_message: 'Grace donated €5.00',
	colour: '#1f8fff'
};

/**
 * Relative luminance of an `rgb(…)` string, as WCAG defines it.
 *
 * Written out rather than imported from `src/lib/color.ts`: that module measures the colours this
 * project *chooses*, and using it here would mean a mistake in it could agree with itself and pass.
 * What a browser computed is the only thing worth measuring at this level.
 */
function luminanceOf(colour: string): number {
	const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);

	if (parts === null) throw new Error(`not an rgb colour: ${colour}`);

	const [r, g, b] = parts.slice(1, 4).map((value) => {
		const channel = Number(value) / 255;

		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});

	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The page's background and its text colour, as the browser computed them. */
async function contrastOf(page: Page): Promise<{ background: string; ink: string }> {
	return page.locator('.chat').evaluate((node) => {
		const style = getComputedStyle(node);

		return { background: style.backgroundColor, ink: style.color };
	});
}

/** Answers the three endpoints the page calls, so nothing reaches a real provider. */
async function stub(
	page: Page,
	bodies: {
		chat?: object;
		activity?: object;
	} = {}
): Promise<void> {
	const chat = bodies.chat ?? {
		ok: true,
		configured: true,
		available: true,
		reason: null,
		messages: [MESSAGE, NOTICE],
		age: 0,
		stale: false,
		generated_at: '2026-10-06T13:00:03+00:00'
	};

	const activity = bodies.activity ?? {
		ok: true,
		configured: true,
		available: true,
		reason: null,
		activities: [DONATION],
		age: 0,
		stale: false,
		generated_at: '2026-10-06T13:00:03+00:00'
	};

	await page.route('**/api/chat*', (route) => route.fulfill({ json: chat }));
	await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));

	// An event stream that connects and says nothing. `EventSource` would otherwise retry against
	// the real endpoint for as long as the context lives.
	await page.route('**/api/events*', (route) =>
		route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry:60000\n\n' })
	);
}

test('renders a chat message with its author and text', async ({ page }) => {
	await stub(page);
	await page.goto('/chat');

	await expect(page.getByText('first message')).toBeVisible();
	// The author links to the profile the server resolved, and only because it resolved one.
	await expect(page.getByRole('link', { name: 'Ada' })).toHaveAttribute(
		'href',
		'https://www.twitch.tv/ada'
	);
});

test('renders a viewer with no profile as plain text, not a dead link', async ({ page }) => {
	await stub(page);
	await page.goto('/chat');

	await expect(page.getByText('Linus')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Linus' })).toHaveCount(0);
});

/**
 * The notice label, which exists only because a gift usually renders as a picture.
 *
 * Both directions, because the first version of this had no condition at all and printed
 * "sent Rose sent Rose" — found by looking at the rendered page, and not caught by any of the other
 * tests here, which is why it has two of its own.
 */
test('does not repeat a notice whose content is already readable', async ({ page }) => {
	// This gift arrived with no image, so the segments spell it out and the label would duplicate.
	await stub(page);
	await page.goto('/chat');

	await expect(page.getByText('sent Rose')).toBeVisible();

	const text = (await page.getByRole('log').textContent()) ?? '';

	expect(text.split('sent Rose')).toHaveLength(2);
});

test('labels a notice whose content is only a picture', async ({ page }) => {
	// With an image the segments draw a gift and nothing legible, so the plain text has to go
	// beside it — and is also what is left if the image never loads.
	await stub(page, {
		chat: {
			ok: true,
			configured: true,
			available: true,
			reason: null,
			messages: [
				{
					...NOTICE,
					text: 'sent Rose',
					parts: [
						{ kind: 'text', text: 'sent ' },
						{ kind: 'gift', text: 'Rose', imageUrl: 'https://example.invalid/rose.png' }
					]
				}
			],
			age: 0,
			stale: false,
			generated_at: '2026-10-06T13:00:03+00:00'
		}
	});
	await page.goto('/chat');

	await expect(page.locator('.notice-label')).toHaveText('sent Rose');
});

test('merges support events into the log in time order', async ({ page }) => {
	await stub(page);
	await page.goto('/chat');

	// The donation is the newest of the three, so it is last. Checked as the rendered order of the
	// whole log rather than three separate visibility assertions, which would pass in any order.
	const log = page.getByRole('log');

	await expect(log).toContainText('first message');
	await expect(log).toContainText('Grace');

	const text = (await log.textContent()) ?? '';

	expect(text.indexOf('first message')).toBeLessThan(text.indexOf('Grace'));
});

test('formats a donation as money in the page language', async ({ page }) => {
	await stub(page);
	await page.goto('/chat');

	// `Intl.NumberFormat`, not a hand-written symbol. The English page puts the symbol first.
	await expect(page.getByRole('log')).toContainText('€5.00');
});

test('leaves support events out when asked to', async ({ page }) => {
	await stub(page);
	await page.goto('/chat?events=0');

	await expect(page.getByText('first message')).toBeVisible();
	await expect(page.getByRole('log')).not.toContainText('Grace');
});

test('says so when the provider cannot read chat', async ({ page }) => {
	// `available: false` is a configuration state, not an error, and the page has to distinguish it
	// from a channel that is simply quiet.
	await stub(page, {
		chat: {
			ok: true,
			configured: true,
			available: false,
			reason: 'This token cannot read the channel chat.',
			messages: [],
			age: 0,
			stale: false,
			generated_at: '2026-10-06T13:00:03+00:00'
		}
	});
	await page.goto('/chat');

	await expect(page.getByRole('log')).toContainText('unavailable');
});

test('says the channel is quiet rather than broken when there is nothing to show', async ({
	page
}) => {
	await stub(page, {
		chat: {
			ok: true,
			configured: true,
			available: true,
			reason: null,
			messages: [],
			age: 0,
			stale: false,
			generated_at: '2026-10-06T13:00:03+00:00'
		},
		activity: {
			ok: true,
			configured: true,
			available: true,
			reason: null,
			activities: [],
			age: 0,
			stale: false,
			generated_at: '2026-10-06T13:00:03+00:00'
		}
	});
	await page.goto('/chat');

	await expect(page.getByRole('log')).toContainText('No messages yet');
});

test('applies the font size and background an OBS source asks for', async ({ page }) => {
	await stub(page);
	await page.goto('/chat?bg=transparent&size=28');

	const chat = page.locator('.chat');

	await expect(chat).toHaveAttribute('data-background', 'transparent');
	await expect(chat).toHaveCSS('font-size', '28px');
	// Transparent is what makes it usable as a browser source: anything painted here would cover
	// the scene behind it.
	await expect(chat).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('drops the avatars, badges and platform marks when told to', async ({ page }) => {
	await stub(page);
	await page.goto('/chat?avatars=0&badges=0&platform=0');

	await expect(page.getByText('first message')).toBeVisible();
	await expect(page.locator('.chat .row .avatar')).toHaveCount(0);
	await expect(page.locator('.chat .row .platform')).toHaveCount(0);
});

test('reverses the log when asked for newest first', async ({ page }) => {
	await stub(page);
	await page.goto('/chat?order=newest');

	// Waited for before the text is read. `textContent` does not retry, so reading it straight
	// after `goto` catches the log before the backlog fetch resolves — and two `indexOf`s of `-1`
	// compare as "in order" for whichever direction is asserted, which is a test that passes for
	// the wrong reason rather than one that fails honestly.
	await expect(page.getByText('first message')).toBeVisible();

	const text = (await page.getByRole('log').textContent()) ?? '';

	expect(text).toContain('Grace');
	expect(text.indexOf('Grace')).toBeLessThan(text.indexOf('first message'));
});

/**
 * Both colour schemes, because this page has no site stylesheet behind it yet.
 *
 * Found by screenshotting it: the page painted a `Canvas` background without declaring
 * `color-scheme`, so a dark-mode browser got a white page — and the version before that set a dark
 * background with no ink at all, which is black on near-black for anyone *not* in dark mode. Both
 * are invisible to whoever built it in one scheme, which is exactly why they are asserted.
 */
test('follows a dark-mode browser', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await stub(page);
	await page.goto('/chat');
	await expect(page.getByText('first message')).toBeVisible();

	const { background, ink } = await contrastOf(page);

	expect(luminanceOf(background)).toBeLessThan(0.2);
	// The text has to be the other way round from the background, whichever way that is.
	expect(luminanceOf(ink)).toBeGreaterThan(luminanceOf(background));
});

test('follows a light-mode browser', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await stub(page);
	await page.goto('/chat');
	await expect(page.getByText('first message')).toBeVisible();

	const { background, ink } = await contrastOf(page);

	expect(luminanceOf(background)).toBeGreaterThan(0.8);
	expect(luminanceOf(ink)).toBeLessThan(luminanceOf(background));
});

test('darkens a bright viewer colour on a light page', async ({ page }) => {
	// A viewer picks their colour against a platform's dark chat. `#53fc19` on white is unreadable,
	// and it is per-message, so no registry can fix it — the row has to.
	await page.emulateMedia({ colorScheme: 'light' });
	await stub(page, {
		chat: {
			ok: true,
			configured: true,
			available: true,
			reason: null,
			messages: [{ ...MESSAGE, author: { ...MESSAGE.author, colour: '#53fc19' } }],
			age: 0,
			stale: false,
			generated_at: '2026-10-06T13:00:03+00:00'
		}
	});
	await page.goto('/chat');

	const author = page.getByRole('link', { name: 'Ada' });

	await expect(author).toBeVisible();

	const colour = await author.evaluate((node) => getComputedStyle(node).color);

	// Still green — the hue is the viewer's choice and is kept — but dark enough to read.
	expect(luminanceOf(colour)).toBeLessThan(luminanceOf('rgb(83, 252, 25)'));
});

test('keeps itself out of search results', async ({ page }) => {
	// An OBS source and a side window are neither of them pages to index, and the settings are in
	// the query string, so each URL would otherwise be a separate indexable document.
	await stub(page);
	await page.goto('/chat');

	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('logs nothing to the console', async ({ page }) => {
	// A Svelte hydration mismatch or a failed import shows up here and nowhere else, and it is the
	// one class of UI failure that leaves the page looking almost right.
	const problems: string[] = [];

	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
	});
	page.on('pageerror', (error) => problems.push(error.message));

	await stub(page);
	await page.goto('/chat');
	await expect(page.getByText('first message')).toBeVisible();

	expect(problems).toEqual([]);
});
