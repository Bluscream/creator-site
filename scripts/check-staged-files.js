#!/usr/bin/env node
/**
 * Refuses to commit files that should never be in the repository.
 *
 * `.gitignore` already covers these — but a `git add -f`, a renamed file, or a pattern that stops
 * matching after a directory moves all route around it, and the result is a key in a public
 * repository. This is the second lock on the same door, and it checks the thing itself (the
 * staged path list) rather than trusting the configuration that is supposed to prevent it.
 *
 * Two other failure modes worth catching here, both of which have happened to real projects:
 * committing a database, and committing a file so large it makes the clone slow forever.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

/** Paths that must never be staged, with the reason shown when one is. */
const FORBIDDEN = [
	{ pattern: /(^|\/)\.env$/, why: 'the real environment file — commit .env.example instead' },
	{
		pattern: /(^|\/)\.env\.(?!example$|test$)[^/]+$/,
		why: 'an environment file; only .env.example and .env.test belong in the repository'
	},
	{ pattern: /\.(pem|key|p12|pfx|keystore|jks)$/i, why: 'a private key or certificate store' },
	{ pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: 'an SSH private key' },
	{ pattern: /(^|\/)\.npmrc$/, why: 'may carry a registry auth token — keep it out of the tree' },
	{ pattern: /\.(db|sqlite|sqlite3)$/i, why: "a database; this project's data is never committed" },
	{ pattern: /(^|\/)\.DS_Store$/, why: 'macOS clutter' },
	{
		pattern: /\.log$/i,
		why: 'a log file — runtime output, never source'
	},
	{
		pattern: /^data\//,
		why: 'the runtime data directory (DATA_DIR) — the database, logs and cache live here'
	}
];

/** A file this big is almost always a mistake, and it is in the clone forever. */
const MAX_BYTES = 2 * 1024 * 1024;

const staged = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
	encoding: 'utf8'
})
	.stdout.split('\n')
	.map((line) => line.trim())
	.filter(Boolean);

/** @type {string[]} */
const problems = [];

for (const path of staged) {
	for (const { pattern, why } of FORBIDDEN) {
		if (pattern.test(path)) {
			problems.push(`${path} — ${why}`);
		}
	}

	try {
		const { size } = statSync(path);

		if (size > MAX_BYTES) {
			const mb = (size / 1024 / 1024).toFixed(1);
			problems.push(`${path} — ${mb} MB, over the ${String(MAX_BYTES / 1024 / 1024)} MB limit`);
		}
	} catch {
		// Staged but gone from the working tree — a rename or a delete. Not this check's business.
	}
}

if (problems.length > 0) {
	console.error('\n  These must not be committed:\n');

	for (const problem of problems) {
		console.error(`    ${problem}`);
	}

	console.error('\n  If one of them genuinely belongs here, add it to FORBIDDEN as an exception');
	console.error('  with a reason, rather than passing --no-verify.');
	process.exit(1);
}

console.error(`      clean (${String(staged.length)} files)`);
