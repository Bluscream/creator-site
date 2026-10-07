// See https://svelte.dev/docs/kit/types#app.d.ts for information about these interfaces.
import type { Principal } from '#lib/server/session.js';

declare global {
	// SvelteKit's ambient types are keyed on a global `App` namespace — `Locals`, `PageData` and
	// the rest are only found here, and there is no module form of this declaration. The ban on
	// namespaces stands everywhere else in the project.
	// eslint-disable-next-line no-restricted-syntax -- required by SvelteKit, see above
	namespace App {
		// interface Error {}

		interface Locals {
			/**
			 * Who is signed in, resolved once per request by `hooks.server.ts`.
			 *
			 * Null for a visitor with no session, an expired one, or a session whose user is gone —
			 * three cases nothing downstream has a reason to tell apart. Never read the session
			 * cookie directly: a page that resolves its own session is a page that can forget to.
			 */
			principal: Principal | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
