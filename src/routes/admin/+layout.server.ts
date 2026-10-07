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

import { requireRole } from '#lib/server/auth/guard.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	const principal = requireRole(locals, url, 'editor');

	return {
		principal,

		// Where a sign-out from the admin navigation should land. Not the current page, which needs a
		// session to view: signing out and being bounced to a sign-in page reads like the sign-out
		// failed.
		signOutTo: '/'
	};
};
