/**
 * The chat page's query-string settings.
 *
 * Worth testing closely for one reason: this is the only place on the page where untrusted input
 * is turned into a value, and every consumer downstream assumes it already has. A `size` of `1e9`
 * reaching the font size, or a `bg` of anything at all reaching a `data-` attribute, is this
 * function's failure and nobody else's.
 *
 * The parameter *names* are also a compatibility surface — `bg`, `size`, `fade` — because OBS
 * browser-source URLs written against the PHP page are saved in people's scene collections. A
 * renamed parameter silently reverts someone's overlay to the defaults, so the names are asserted
 * rather than left to the implementation.
 */

import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, CHAT_DEFAULTS, ORDERS, chatSettings } from '#lib/chat-settings.js';

/** Settings for a query string. */
const from = (query: string): ReturnType<typeof chatSettings> =>
	chatSettings(new URLSearchParams(query));

describe('with nothing in the query string', () => {
	it('is exactly the defaults', () => {
		expect(from('')).toEqual(CHAT_DEFAULTS);
	});

	it('defaults to the mode a human reader wants, not the OBS one', () => {
		// A visitor who typed the address gets the page background and the newest message at the
		// bottom. `transparent` and `newest` are overlay choices and have to be asked for.
		expect(CHAT_DEFAULTS.background).toBe('page');
		expect(CHAT_DEFAULTS.order).toBe('oldest');
	});
});

describe('flags', () => {
	it.each(['1', 'true', 'yes', 'on', 'TRUE', 'On'])('%o is on', (value) => {
		expect(from(`avatars=${value}`).avatars).toBe(true);
	});

	it.each(['0', 'false', 'no', 'off', 'nope', '2'])('%o is off', (value) => {
		// The PHP's rule, kept: anything that is not one of the four true words is off. A client
		// that sends `avatars=maybe` gets a definite answer rather than the default.
		expect(from(`avatars=${value}`).avatars).toBe(false);
	});

	it('falls back to the default for a present but empty flag', () => {
		// `?avatars=` is what a form submits for an untouched field, and it means "unset" rather
		// than "off".
		expect(from('avatars=').avatars).toBe(CHAT_DEFAULTS.avatars);
	});

	it.each([
		['events', 'events'],
		['avatars', 'avatars'],
		['badges', 'badges'],
		['platform', 'platform']
	] as const)('%s is readable under its own name', (param, key) => {
		expect(from(`${param}=0`)[key]).toBe(false);
	});
});

describe('numbers', () => {
	it('reads a plain number', () => {
		expect(from('size=24').fontSize).toBe(24);
		expect(from('limit=20').limit).toBe(20);
		expect(from('fade=60').fadeAfter).toBe(60);
	});

	it('clamps rather than refusing', () => {
		// A URL in somebody's scene collection should keep working with a sane value rather than
		// falling back to the default, which would look like the parameter being ignored.
		expect(from('size=9999').fontSize).toBe(48);
		expect(from('size=1').fontSize).toBe(10);
		expect(from('limit=0').limit).toBe(5);
		expect(from('limit=100000').limit).toBe(200);
		expect(from('fade=99999').fadeAfter).toBe(3600);
	});

	it.each(['1e9', ' 12 ', '0x10', 'Infinity', '-5', '12.5', 'twelve', ''])(
		'ignores %o rather than coercing it',
		(value) => {
			// `Number()` accepts every one of these. Clamping `Infinity` to 48 would be a worse
			// answer than ignoring a parameter that was not a number, because it hides the mistake.
			expect(from(`size=${value}`).fontSize).toBe(CHAT_DEFAULTS.fontSize);
		}
	);

	it('allows zero where zero means something', () => {
		// `fade=0` is "keep messages", which is the default — but it has to be *expressible*, since
		// a URL that says it explicitly is how someone turns fading back off.
		expect(from('fade=0').fadeAfter).toBe(0);
	});
});

describe('choices', () => {
	it.each([...BACKGROUNDS])('bg=%s is accepted', (value) => {
		expect(from(`bg=${value}`).background).toBe(value);
	});

	it.each([...ORDERS])('order=%s is accepted', (value) => {
		expect(from(`order=${value}`).order).toBe(value);
	});

	it.each(['chartreuse', 'PAGE', '', 'page;background:url(x)'])(
		'falls back for bg=%o rather than passing it through',
		(value) => {
			// This value reaches a `data-background` attribute, so an unknown one must never survive
			// this function. The last case is the reason it is a closed list and not a sanitiser.
			expect(BACKGROUNDS).toContain(from(`bg=${value}`).background);
		}
	);

	it('falls back for an unknown order', () => {
		expect(from('order=sideways').order).toBe(CHAT_DEFAULTS.order);
	});
});

describe('every setting the page can be given', () => {
	it('reads a full OBS url', () => {
		// The example from the PHP page's own help text, so an overlay configured against it keeps
		// behaving the same way.
		expect(from('bg=transparent&size=20&fade=60&limit=20')).toEqual({
			...CHAT_DEFAULTS,
			background: 'transparent',
			fontSize: 20,
			fadeAfter: 60,
			limit: 20
		});
	});

	it('ignores a parameter it does not know', () => {
		// The page is linked to from elsewhere, and a tracking parameter must not change the view.
		expect(from('utm_source=newsletter&fbclid=123')).toEqual(CHAT_DEFAULTS);
	});
});
