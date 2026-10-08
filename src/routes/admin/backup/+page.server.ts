/**
 * Backing the install up, and putting a backup back.
 *
 * `owner` rather than the layout's `editor`, for both halves. A download is a copy of every table —
 * sessions, linked accounts, their stored credentials — and a restore replaces all of it. Neither
 * is a thing an editor should be able to do, and neither is undoable by the person who did it.
 *
 * The download is not here: it has to return a file rather than data for a page, so it is a route
 * of its own at `./archive`. This file holds the restore, which is an action because what it
 * returns *is* a page state — what was restored, or why it was refused.
 *
 * ### Why the refusals are passed through as they are
 *
 * The two modules underneath distinguish a wrong password from a damaged file from an archive
 * written by a newer build, and every one of those has a different thing the operator should do
 * next. Collapsing them into "that did not work" on the way to the page would throw away the only
 * useful part. So the problem code travels to the page, and the page turns it into a sentence in
 * the viewer's language.
 */

import { fail } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requireRole } from '#lib/server/auth/guard.js';
import { ArchiveRefusal } from '#lib/server/backup/archive.js';
import { RestoreRefusal, inspectBackup, restoreBackup } from '#lib/server/backup/index.js';
import { log } from '#lib/server/log.js';
import { dataPath } from '#lib/server/paths.js';
import { MAXIMUM_UPLOAD, MINIMUM_PASSWORD } from './policy.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	requireRole(locals, url, 'owner');

	return { minimumPassword: MINIMUM_PASSWORD };
};

export const actions: Actions = {
	/** Looks at an uploaded archive and reports what is in it, without changing anything. */
	inspect: async (event) => run(event, 'inspect'),

	/** Replaces the database and the configuration with an uploaded archive's. */
	restore: async (event) => run(event, 'restore')
};

/** What a refused submission tells the page. The code, and the module's own sentence for a log. */
interface Problem {
	readonly problem: string;
	readonly detail?: string;
}

/** What the page is told, beyond the problem code. */
interface Outcome {
	readonly createdAt?: string;
	readonly entries?: number;
	readonly superseded?: string;
}

/**
 * Both actions, which differ only in what they do once the archive is in hand.
 *
 * One function because everything before that point is identical — the guard, the upload, the
 * temporary file, the refusal mapping — and two copies of it would be two places for the inspect
 * path to quietly accept something the restore path refuses.
 */
async function run(
	event: Parameters<Actions[string]>[0],
	what: 'inspect' | 'restore'
): Promise<{ readonly done: true; readonly outcome: Outcome } | ActionFailure<Problem>> {
	const principal = requireRole(event.locals, event.url, 'owner');

	let data;

	try {
		data = await event.request.formData();
	} catch (cause) {
		// The adapter's body limit lands here, and it is the most likely first failure on a real
		// install: `BODY_SIZE_LIMIT` defaults to 512 KiB, which no database fits in.
		log().warn({ err: cause }, 'a backup upload could not be read');

		return fail(413, { problem: 'upload_too_large' });
	}

	const file = data.get('archive');
	const password = data.get('password');

	if (!(file instanceof File) || file.size === 0) return fail(400, { problem: 'no_file' });
	if (file.size > MAXIMUM_UPLOAD) return fail(413, { problem: 'upload_too_large' });
	if (typeof password !== 'string' || password === '') return fail(400, { problem: 'no_password' });

	const directory = dataPath('.work');

	await mkdir(directory, { recursive: true });

	const path = join(directory, `upload-${crypto.randomUUID()}.crsbak`);

	try {
		// Streamed to disk rather than held as bytes. `formData` has already buffered it, which is
		// the adapter's doing and the reason for the second limit above — but the modules underneath
		// take a seekable path, and nothing is served by keeping a second copy in memory while they
		// read it.
		await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(path));

		if (what === 'inspect') {
			const manifest = await inspectBackup(path, password);

			return {
				done: true as const,
				outcome: { createdAt: manifest.createdAt, entries: manifest.entries.length }
			};
		}

		const report = await restoreBackup(path, password);

		log().warn(
			{ userId: principal.userId, backup: report.manifest.createdAt },
			'an owner restored a backup'
		);

		return {
			done: true as const,
			outcome: {
				createdAt: report.manifest.createdAt,
				entries: report.manifest.entries.length,
				superseded: report.superseded
			}
		};
	} catch (cause) {
		if (cause instanceof ArchiveRefusal || cause instanceof RestoreRefusal) {
			// Not logged as an error: a wrong password is an ordinary thing for a person to do, and
			// filling the log with it would make the real failures harder to find.
			log().info({ problem: cause.problem }, 'a backup was refused');

			return fail(422, { problem: cause.problem, detail: cause.message });
		}

		log().error({ err: cause }, 'a backup could not be read');

		return fail(500, { problem: 'internal_error' });
	} finally {
		await rm(path, { force: true });
	}
}
