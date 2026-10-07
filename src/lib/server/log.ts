/**
 * The site's own log, so there is something for an admin to read.
 *
 * Ported from `Log.php`, which hand-wrote a tab-separated format, size-based rotation, and a
 * backwards block-walking tail reader. All three are libraries now:
 *
 * - **pino** for the logger — levels, structured fields, and `redact`, which is the one that earns
 *   its place. "Never log a token" was a rule someone had to remember; it is now a configured list
 *   of field names that are censored before anything is written.
 * - **rotating-file-stream** for rotation. Chosen over `pino-roll` because it is an ordinary
 *   Writable rather than a pino transport: a transport runs in a worker thread resolved by name at
 *   runtime, which is exactly the thing that breaks once a bundler is involved.
 * - **read-last-lines** for the tail, which is what the admin page needs and what reading a
 *   megabyte to show fifty lines was.
 *
 * ### Still deliberately dependency-free
 *
 * Nothing here reads `config.ts`, and nothing here throws. Configuration failures are logged —
 * which is *during* configuration's own bootstrap — so a logger that needed configuration would
 * recurse exactly when the site is most broken. Everything is read straight from the environment
 * and every write is best-effort.
 *
 * Both destinations, not one: the container's stderr stays the place an operator with `docker logs`
 * looks, and losing that to gain a web page would be a bad trade.
 */

import { mkdirSync, statSync, truncateSync } from 'node:fs';
import pino from 'pino';
import readLastLines from 'read-last-lines';
import { createStream } from 'rotating-file-stream';
import { z } from 'zod';
import { dataDir, dataPath } from './paths.js';

/** Rotated at a megabyte, keeping one previous file. Enough to read back a bad afternoon. */
const MAX_SIZE = '1M';
const KEEP_FILES = 2;

const FILENAME = 'creator-site.log';

/**
 * Where the log goes.
 *
 * `paths.ts` reads the environment directly rather than going through `config.ts`, for the reason
 * in the note above — and defaults beside the database rather than anywhere web-reachable, since a
 * log that could be fetched would be a log of someone else's requests.
 */
export function logPath(): string {
	return dataPath(FILENAME);
}

/**
 * Field names whose values are never written, at any level, in any record.
 *
 * pino replaces the value with the censor before serialising, so a token passed by accident in a
 * context object cannot reach either destination. This is a list to extend, not a rule to remember.
 */
const REDACTED = [
	'token',
	'secret',
	'password',
	'authorization',
	'cookie',
	'apiKey',
	'api_key',
	'clientSecret',
	'client_secret',
	'accessToken',
	'access_token',
	'refreshToken',
	'refresh_token',
	'*.token',
	'*.secret',
	'*.password',
	'*.authorization'
];

let instance: pino.Logger | null = null;

/**
 * The logger, built on first use.
 *
 * Lazy because the file stream creates a directory, and a module that does that on import makes
 * every test and every build that merely mentions it touch the filesystem.
 */
export function log(): pino.Logger {
	if (instance !== null) return instance;

	const streams: pino.StreamEntry[] = [{ stream: process.stderr }];

	try {
		mkdirSync(dataDir(), { recursive: true });

		streams.push({
			stream: createStream(FILENAME, {
				path: dataDir(),
				size: MAX_SIZE,
				maxFiles: KEEP_FILES,
				// Compressing a log an admin page reads back would mean decompressing it to read it.
				compress: false
			})
		});
	} catch (error) {
		// A log file we cannot write is not a reason to lose the message. stderr still has it, and
		// this says why the web page is empty.
		process.stderr.write(
			`[creator-site] cannot write ${logPath()}: ${error instanceof Error ? error.message : 'unknown'}\n`
		);
	}

	instance = pino(
		{
			level: process.env.LOG_LEVEL ?? 'info',
			redact: { paths: REDACTED, censor: '[redacted]' },
			// No pid or hostname on every line: one process in one container, so both are noise.
			base: null
		},
		pino.multistream(streams)
	);

	return instance;
}

/** One entry as the admin page reads it back. */
export interface LogEntry {
	readonly at: string;
	readonly level: string;
	readonly message: string;
}

/**
 * pino's own record shape, as far as this needs it.
 *
 * Parsed rather than trusted: the file is also written to by rotation and may contain a line from
 * an older format, or from something else entirely.
 */
const recordSchema = z.object({
	time: z.number().optional(),
	level: z.number().optional(),
	msg: z.string().optional()
});

/** pino's numeric levels, by name. */
const LEVELS: Readonly<Record<number, string>> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal'
};

/**
 * The most recent entries, newest first.
 *
 * Reads the tail rather than the file: this rotates at a megabyte, and a page asking for fifty
 * lines should not pull all of it into memory to throw almost all of it away.
 */
export async function readLog(limit = 200): Promise<readonly LogEntry[]> {
	const count = Math.max(1, Math.min(2000, limit));

	let text: string;

	try {
		text = await readLastLines.read(logPath(), count);
	} catch {
		// No file yet, or it is unreadable. An empty log reads as empty, not as an error.
		return [];
	}

	const entries = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.map(toEntry);

	return entries.toReversed();
}

/**
 * One line as an entry.
 *
 * A line written by something other than this logger is still worth showing — it just has no
 * timestamp or level of its own.
 */
function toEntry(line: string): LogEntry {
	let parsed: unknown;

	try {
		parsed = JSON.parse(line);
	} catch {
		return { at: '', level: 'info', message: line };
	}

	const record = recordSchema.safeParse(parsed);

	if (!record.success || record.data.msg === undefined) {
		return { at: '', level: 'info', message: line };
	}

	const { time, level, msg } = record.data;

	return {
		at: time === undefined ? '' : new Date(time).toISOString(),
		level: (level === undefined ? undefined : LEVELS[level]) ?? 'info',
		message: msg
	};
}

/** Throws the log away. Returns whether there is now nothing in it. */
export function clearLog(): boolean {
	try {
		truncateSync(logPath(), 0);

		return true;
	} catch (error) {
		// Nothing to clear is success: the caller asked for an empty log and the log is empty.
		return isMissing(error);
	}
}

/** How big the log is, for a page to show without reading it. */
export function logSize(): number {
	try {
		return statSync(logPath()).size;
	} catch {
		return 0;
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'ENOENT'
	);
}
