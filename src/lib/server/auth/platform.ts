/**
 * What a platform offers an account that links to it.
 *
 * The seam before this one was `./sign-in-provider.ts`, and it answered one question: *how do I sign
 * somebody in with this?* That was the right seam while signing in was the only thing a platform was
 * for. It is the wrong one now, because the design this project settled on is that **one link serves
 * everything** — signing in, the credentials the post/chat/live readers need, and the "socials" the
 * public page shows. A platform that can do three of those and not the fourth has to be able to say
 * so, and a page offering a link has to be able to ask.
 *
 * So a platform is described here, once, and the sign-in provider becomes one *part* of that
 * description rather than the whole of it.
 *
 * ### Two lists, not one
 *
 * {@link AccountPlatform.capabilities} is what a link *is good for*; {@link AccountPlatform.methods}
 * is *how to get one*. They are independent, and the account page needs both: it offers Kick with an
 * "OAuth" button only, because Kick has no personal access tokens, while it offers X with both and
 * still has to say that the post feed is behind a paid tier. Collapsing them into one list would
 * make "linkable" and "useful" the same claim, which for several of these platforms it is not.
 *
 * ### Why the id is the registry key
 *
 * {@link AccountPlatform.id} is simultaneously `connections.platform`, `identities.provider`, the
 * `/auth/<id>/login` URL segment and a key of the registry in `src/lib/platforms.ts` — which is
 * where the icon, the display name and the brand colour already live. One id, so a linked account
 * renders with the same mark as a configured post source, and so nothing has a second table mapping
 * one spelling to another. `platform-registry.test.ts` holds that to it.
 */

import type { LinkMethod } from '#lib/server/db/schema.js';
import type { Grant, SignInProvider } from './sign-in-provider.js';

/**
 * What a linked account can be used for.
 *
 * Deliberately the *capability*, never the vendor: `posts` is "this link can read the creator's own
 * content", whether that content is VODs, uploads or threads. A page switches on these, so adding a
 * platform never adds a branch anywhere.
 */
export const CAPABILITIES = ['sign-in', 'posts', 'chat', 'live', 'activity', 'social'] as const;

/** One of {@link CAPABILITIES}. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A personal access token somebody pasted, checked against the platform.
 *
 * Checked at the point it is pasted rather than on first use, because the failure modes of a wrong
 * token are a feed that silently stays empty and a live badge that never lights — neither of which
 * points at the form that caused it. A platform that offers `token` linking must therefore be able
 * to answer "whose account is this, and does this token work" — which is the same thing an OAuth
 * exchange ends up knowing, and is why both produce a {@link Grant}.
 */
export interface TokenLink {
	/**
	 * What to tell somebody to paste, and where to get it.
	 *
	 * Shown beside the field. Platform-specific by necessity — "a Twitch OAuth token from the CLI"
	 * and "a Google API key" are not the same instruction — and kept with the platform so the form
	 * stays generic.
	 */
	readonly hint: string;

	/**
	 * Whose account the token belongs to, and what it is good for.
	 *
	 * A {@link Grant} rather than an identity, because a link has to store the scopes the token
	 * actually carries and when it expires — and the call that answers "whose token is this" is the
	 * same call that answers both. Returning only the identity would mean validating twice and
	 * leaving the stored scopes to a guess.
	 *
	 * The `accessToken` on the result is the token as it will be stored, which is not always the
	 * string that was passed in: a paste picks up whitespace, and the trimmed value is the one that
	 * was proven to work.
	 *
	 * Throws a `SignInFailure` when the platform rejects it, with a message for the person who pasted
	 * it and never the platform's own response body — a rejected credential request can echo the
	 * credential.
	 */
	verify(token: string): Promise<Grant>;
}

/** One platform an account can be linked to. */
export interface AccountPlatform {
	/** The registry key. See the note at the top — this is written into rows and URLs. */
	readonly id: string;

	/** What to call it in a button or a heading. */
	readonly label: string;

	/** What a link to it can serve. Never empty: a platform good for nothing is not one. */
	readonly capabilities: readonly Capability[];

	/**
	 * A limitation worth telling the creator about, or null.
	 *
	 * For the honest cases the research turned up — X can be linked and its identity read, but the
	 * free tier cannot read the creator's own timeline. Surfacing that in the admin is the difference
	 * between a documented limitation and a feed that looks broken.
	 *
	 * ### A function, so it cannot be an untranslated string
	 *
	 * This was `string | null`, which is the one field on this interface a platform renders verbatim
	 * — and a plain string here is an English sentence on a German page. The project's first rule is
	 * that every visible string goes through a message function, but the check that enforces it parses
	 * markup, and a platform module is TypeScript: the string would have been invisible to it forever.
	 *
	 * So the type asks for a thunk, which in practice calls a message function — see
	 * `./kick-platform.ts` for the only one that has a caveat today. That puts the sentence in the
	 * catalogue where a translator can reach it, and makes the key visible to the dead-key scan, which
	 * already reads `.ts`. The alternative, a key the page looks up dynamically, would defeat both:
	 * a computed `m[name]()` is exactly the shape that scan cannot see.
	 *
	 * (Deliberately described rather than demonstrated: that scan is a regex over whole files, so a
	 * call written in prose here would be reported as a reference to a key the catalogue lacks. It
	 * fails loudly when that happens, which is the right way round for this kind of check.)
	 *
	 * Called where the locale is known, which is the load function rather than this module.
	 */
	readonly caveat: (() => string) | null;

	/**
	 * How it can be linked, in the order the account page should offer them.
	 *
	 * OAuth first wherever it exists, because the secret never passes through a form. `login` last
	 * and only where a platform offers nothing else.
	 */
	readonly methods: readonly LinkMethod[];

	/** The OAuth half, when {@link methods} includes `oauth`. */
	readonly oauth: SignInProvider | null;

	/** The paste-a-token half, when {@link methods} includes `token`. */
	readonly token: TokenLink | null;

	/**
	 * Whether this installation can actually link by a given method.
	 *
	 * Per method, because they are configured separately: a build with no Discord application cannot
	 * offer OAuth but could still accept a token. A method that is offered and then fails on the
	 * platform's own error page is worse than one that is not offered, because the person cannot tell
	 * which end is broken.
	 */
	usable(method: LinkMethod): boolean;
}

/** Whether a platform claims a capability. */
export function supports(platform: AccountPlatform, capability: Capability): boolean {
	return platform.capabilities.includes(capability);
}

/**
 * The methods this installation can actually offer for a platform.
 *
 * Both halves of the question at once — declared *and* configured — because every caller wants that
 * and asking it in two steps is how a button for an unconfigured method gets rendered.
 */
export function offeredMethods(platform: AccountPlatform): readonly LinkMethod[] {
	return platform.methods.filter((method) => platform.usable(method));
}

/** Whether a platform can be linked at all on this installation. */
export function linkable(platform: AccountPlatform): boolean {
	return offeredMethods(platform).length > 0;
}
