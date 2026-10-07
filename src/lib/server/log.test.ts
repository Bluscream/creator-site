/**
 * The logger, checked where it can actually go wrong.
 *
 * pino, rotating-file-stream and read-last-lines are tested upstream; what is worth testing here is
 * this project's configuration of them. One of those is a security property rather than a
 * convenience — a token must not reach the log — so it is checked rather than trusted to a list
 * someone remembers to extend.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LogModuleShape from '#lib/server/log.js';

type LogModule = typeof LogModuleShape;

let directory: string;

/**
 * A fresh module in a fresh directory.
 *
 * The logger caches its instance and its file stream, so every case needs its own copy of the
 * module or they write to each other's files.
 */
async function freshLog(): Promise<LogModule> {
	vi.resetModules();

	return import('#lib/server/log.js');
}

/**
 * Waits for a line to reach the file.
 *
 * pino writes through a stream, so a write is not on disk the instant the call returns. Polling for
 * the condition is honest about that; a fixed sleep would be a race that usually passes.
 */
async function waitForLines(path: string, count: number): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const text = readFileSync(path, 'utf8');

			if (text.split('\n').filter((line) => line.trim() !== '').length >= count) return text;
		} catch {
			// Not created yet.
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	throw new Error(`${path} never reached ${String(count)} lines`);
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'creator-site-log-'));
	vi.stubEnv('DATA_DIR', directory);
	vi.stubEnv('LOG_LEVEL', 'info');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe('writing and reading back', () => {
	it('puts a line in the file and reads it as an entry', async () => {
		const { log, logPath, readLog } = await freshLog();

		log().error('the feed refresh failed');
		await waitForLines(logPath(), 1);

		const entries = await readLog();

		expect(entries).toHaveLength(1);
		expect(entries[0]?.message).toBe('the feed refresh failed');
		expect(entries[0]?.level).toBe('error');
		expect(entries[0]?.at).not.toBe('');
	});

	it('reads newest first, which is what a log page shows', async () => {
		const { log, logPath, readLog } = await freshLog();

		log().info('first');
		log().info('second');
		log().info('third');
		await waitForLines(logPath(), 3);

		expect((await readLog()).map((entry) => entry.message)).toStrictEqual([
			'third',
			'second',
			'first'
		]);
	});

	it('honours the limit, because the point is not reading the whole file', async () => {
		const { log, logPath, readLog } = await freshLog();

		for (let n = 0; n < 20; n += 1) log().info(`line ${String(n)}`);
		await waitForLines(logPath(), 20);

		expect(await readLog(5)).toHaveLength(5);
	});

	it('names every level it writes', async () => {
		const { log, logPath, readLog } = await freshLog();

		log().warn('careful');
		log().error('broken');
		log().fatal('gone');
		await waitForLines(logPath(), 3);

		expect((await readLog()).map((entry) => entry.level)).toStrictEqual(['fatal', 'error', 'warn']);
	});

	it('shows a line it did not write rather than dropping it', async () => {
		// A line from an older format, or from something else entirely, is still worth showing — it
		// just has no timestamp or level of its own.
		const { logPath, readLog } = await freshLog();

		writeFileSync(logPath(), 'not json at all\n{"msg":"half a record"}\n');

		const entries = await readLog();

		expect(entries.map((entry) => entry.message)).toStrictEqual([
			'half a record',
			'not json at all'
		]);
		expect(entries[1]?.level).toBe('info');
	});
});

describe('redaction', () => {
	// The requirement this enforces: never log a token, a secret, a password or an auth header.
	// A rule nobody checks is a rule that holds until the first hurried debug line.
	it.each([
		['token', 'syn_live_abcdefghijklmnop'],
		['secret', 'super-secret-value'],
		['password', 'hunter2'],
		['authorization', 'Bearer abcdefghijklmnop'],
		['clientSecret', 'discord-client-secret-value'],
		['accessToken', 'ya29.a0AfH6SMB-token-value'],
		['refresh_token', 'refresh-token-value']
	])('censors %s', async (field, value) => {
		const { log, logPath } = await freshLog();

		log().error({ [field]: value }, 'request failed');

		const text = await waitForLines(logPath(), 1);

		expect(text, `${field} leaked`).not.toContain(value);
		expect(text).toContain('[redacted]');
	});

	it('censors a secret one level down, not only at the top', async () => {
		const { log, logPath } = await freshLog();

		log().error({ upstream: { token: 'nested-token-value' } }, 'upstream rejected us');

		const text = await waitForLines(logPath(), 1);

		expect(text).not.toContain('nested-token-value');
		expect(text).toContain('[redacted]');
	});

	it('leaves everything else alone', async () => {
		// Redaction that swallowed the context would make the log useless, which is its own failure.
		const { log, logPath } = await freshLog();

		log().error({ platform: 'twitch', status: 503 }, 'upstream unavailable');

		const text = await waitForLines(logPath(), 1);

		expect(text).toContain('twitch');
		expect(text).toContain('503');
	});
});

describe('the housekeeping a log page needs', () => {
	it('reports the size without reading the file', async () => {
		const { log, logPath, logSize } = await freshLog();

		expect(logSize()).toBe(0);

		log().info('something');
		await waitForLines(logPath(), 1);

		expect(logSize()).toBeGreaterThan(0);
	});

	it('empties the log', async () => {
		const { log, logPath, logSize, clearLog, readLog } = await freshLog();

		log().info('something');
		await waitForLines(logPath(), 1);

		expect(clearLog()).toBe(true);
		expect(logSize()).toBe(0);
		expect(await readLog()).toStrictEqual([]);
	});

	it('treats an absent log as already empty', async () => {
		// The caller asked for an empty log, and the log is empty. An error here would make a fresh
		// install look broken.
		const { clearLog, logSize, readLog } = await freshLog();

		expect(clearLog()).toBe(true);
		expect(logSize()).toBe(0);
		expect(await readLog()).toStrictEqual([]);
	});

	it('reads an unwritable directory as an empty log rather than throwing', async () => {
		vi.stubEnv('DATA_DIR', '/proc/definitely/not/writable');

		const { readLog, logSize } = await freshLog();

		expect(await readLog()).toStrictEqual([]);
		expect(logSize()).toBe(0);
	});
});
