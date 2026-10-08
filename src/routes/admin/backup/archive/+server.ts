/**
 * Downloading a backup.
 *
 * A route of its own rather than a form action, because an action returns data for a page to render
 * and this has to return a *file*. The page posts a form here and the browser saves what comes
 * back; no JavaScript is involved, which matters for the one page an operator reaches when things
 * are already going wrong.
 *
 * ### `POST`, not `GET`
 *
 * A `GET` carrying the password would put it in the URL — in history, in the log, in the referrer of
 * anything the next page loads — and the whole database is what the password protects. It would also
 * make the download triggerable by an `<img>` or a prefetcher on another site. So: `POST`, and
 * `GET` is not implemented rather than being a convenience nobody should use.
 *
 * ### Owner only
 *
 * The archive contains every table, which means every session token and every linked account's
 * stored credentials. `editor` is the floor for the admin shell and `admin` governs roles; this is
 * the whole install in one file, so it is the owner's.
 *
 * ### The file is written before it is sent
 *
 * Not streamed as it is built. `createBackup` needs a seekable file to put the authentication tag at
 * the end of, and sending a half-built archive that then fails would hand somebody a file that
 * looks like a backup and is not. So it is written to the data directory's scratch space, streamed
 * out, and removed — and if the write fails, nothing was sent.
 */

import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { requireRoleForApi } from '#lib/server/auth/guard.js';
import { createBackup } from '#lib/server/backup/index.js';
import { log } from '#lib/server/log.js';
import { dataPath } from '#lib/server/paths.js';
import { MINIMUM_PASSWORD } from '../policy.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const principal = requireRoleForApi(locals, 'owner');
	const data = await request.formData();
	const password = data.get('password');

	if (typeof password !== 'string' || password.length < MINIMUM_PASSWORD) {
		// 422 rather than 400: the request is well-formed and the value is not acceptable. The
		// message says the rule, because a refusal an operator cannot act on is a dead end.
		error(
			422,
			`The password for a backup must be at least ${String(MINIMUM_PASSWORD)} characters: it is the only thing protecting a copy of the whole database.`
		);
	}

	const directory = dataPath('.work');

	await mkdir(directory, { recursive: true });

	const name = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.crsbak`;
	const path = join(directory, `download-${name}`);

	try {
		await createBackup(path, password);
	} catch (cause) {
		log().error({ err: cause }, 'could not write a backup for download');
		await rm(path, { force: true });

		error(500, 'The backup could not be written. The log says why.');
	}

	const { size } = await stat(path);
	const file = createReadStream(path);

	// Removed once it has been read, however that ends. A failed download leaving a copy of the
	// database in the data directory would be a quiet way to accumulate them.
	const clean = () => {
		void rm(path, { force: true });
	};

	file.on('close', clean);
	file.on('error', clean);

	log().warn({ userId: principal.userId, bytes: size }, 'a backup was downloaded');

	return new Response(Readable.toWeb(file) as ReadableStream, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(size),
			'content-disposition': `attachment; filename="backup-${name}"`,

			// Nothing about this may be kept by anything between here and the browser.
			'cache-control': 'no-store, private'
		}
	});
};
