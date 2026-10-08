/**
 * The gate on everything under `/admin`.
 *
 * One guard, in a layout, rather than one per page. A per-page check is a check a new page can be
 * written without, and the cost of forgetting is an unprotected admin page — so the default has to be
 * "protected", with a page opting out by not living here.
 *
 * `editor` rather than `admin` as the floor: this layout is the shell, and the narrower checks belong
 * to the pages that do narrower things. A moderator who can only reach the chat moderation page still
 * has to get through this one to see the navigation.
 */

import { atLeast, requireRole } from '#lib/server/auth/guard.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	const principal = requireRole(locals, url, 'editor');

	return {
		principal,

		// Which admin pages this person may reach, so the navigation offers only what will open. A
		// link to a page that answers 403 is worse than no link: it reads as the site being broken
		// rather than as the page not being theirs.
		canSeePeople: atLeast(principal.role, 'admin'),

		// The backup page is the owner's: a download is a copy of every session token and every
		// linked account's stored credentials, and a restore replaces all of it.
		canSeeBackup: atLeast(principal.role, 'owner'),

		// The numbers are `admin` rather than `owner`: business figures, not secrets, and an admin
		// who runs the channel's day to day needs them.
		canSeeMetrics: atLeast(principal.role, 'admin'),

		// Where a sign-out from the admin navigation should land. Not the current page, which needs a
		// session to view: signing out and being bounced to a sign-in page reads like the sign-out
		// failed.
		signOutTo: '/'
	};
};
