/**
 * Everybody with an account, and what they may do.
 *
 * `admin` rather than the layout's `editor`: who may do what is the one setting where a mistake
 * cannot be undone by the person who made it, so an editor seeing the list is harmless and an editor
 * changing a role is not.
 *
 * The refusals live in `accounts.setRole` rather than here, because they are rules about the data
 * and not about this page. Both are about not being able to undo the change: the last owner cannot
 * be demoted, and nobody changes their own role.
 */

import { fail } from '@sveltejs/kit';
import { people, setRole } from '#lib/server/accounts.js';
import { requireRole } from '#lib/server/auth/guard.js';
import { ROLES } from '#lib/server/db/schema.js';
import type { Role } from '#lib/server/db/schema.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = requireRole(locals, url, 'admin');

	return {
		people: people(),
		roles: ROLES,

		// So the page can disable its own row's control rather than offering a button that is refused.
		you: principal.userId
	};
};

export const actions: Actions = {
	default: async ({ locals, request, url }) => {
		const principal = requireRole(locals, url, 'admin');
		const data = await request.formData();
		const userId = field(data, 'userId');
		const role = field(data, 'role');

		if (userId === null || !isRole(role)) return fail(400, { error: 'bad_request' });

		const refusal = setRole(userId, role, principal);

		// 409 for the two rules and 404 for a user who is not there. All three are reported with the
		// reason, because each one has a different thing the person reading it should do next.
		return refusal === null
			? { changed: true }
			: fail(refusal === 'no_such_user' ? 404 : 409, { error: refusal });
	}
};

/** One form field, as a string. `get` can also return a `File`, which is not an answer here. */
function field(data: FormData, name: string): string | null {
	const value = data.get(name);

	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether a submitted value is one of the roles.
 *
 * Checked rather than cast. The value arrives from a `<select>` the page rendered, which means it
 * arrives from whatever the browser chose to send instead.
 */
function isRole(value: string | null): value is Role {
	return value !== null && (ROLES as readonly string[]).includes(value);
}
