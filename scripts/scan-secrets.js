#!/usr/bin/env node
/**
 * Scans what is about to be committed for credentials.
 *
 * Two scanners, deliberately:
 *
 * - **secretlint** is an npm dependency, so it exists for anyone who ran `npm install`. It is the
 *   floor, it is never optional, and a failure here fails the commit.
 * - **gitleaks** has a far broader rule set and reads the staged *diff* rather than whole files,
 *   so it catches a credential added to a file that is otherwise clean. It is a separate binary,
 *   so it may be absent.
 *
 * The important property is that a missing scanner is **reported, never silently skipped**. A hook
 * that prints nothing when a tool is not installed teaches you to read "no output" as "clean",
 * which is exactly the failure this file exists to prevent.
 *
 * Why a script rather than lines in the hook: this needs to run the same way from the hook, from
 * CI, and by hand (`npm run scan:secrets`) when something looks wrong.
 */

import { spawnSync } from 'node:child_process';

/** @param {string} command @param {string[]} args */
function run(command, args) {
	return spawnSync(command, args, { stdio: 'inherit', encoding: 'utf8' });
}

/** @param {string} command */
function exists(command) {
	return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const staged = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
	encoding: 'utf8'
})
	.stdout.split('\n')
	.map((line) => line.trim())
	.filter(Boolean);

if (staged.length === 0) {
	console.error('      nothing staged');
	process.exit(0);
}

let failed = false;

// --- secretlint: always ---------------------------------------------------------------------

const secretlint = run('npx', ['--no-install', 'secretlint', '--maskSecrets', ...staged]);

if (secretlint.status !== 0) {
	console.error('\n      secretlint found a credential in the staged changes.');
	failed = true;
} else {
	console.error(`      secretlint: clean (${String(staged.length)} files)`);
}

// --- gitleaks: when present, and said so when not -------------------------------------------

if (exists('gitleaks')) {
	const gitleaks = run('gitleaks', ['git', '--staged', '--redact', '--no-banner']);

	if (gitleaks.status !== 0) {
		console.error('\n      gitleaks found a credential in the staged diff.');
		failed = true;
	} else {
		console.error('      gitleaks: clean');
	}
} else {
	console.error('      gitleaks: NOT INSTALLED — secretlint ran alone.');
	console.error('                `brew install gitleaks` for the deeper diff scan.');
}

if (failed) {
	console.error(
		'\n  A credential must never reach a commit: rewriting history does not unpublish it.'
	);
	console.error('  Move the value into .env (which is ignored) and commit .env.example instead.');
	console.error(
		'  If this is a false positive, add a narrow ignore with a reason and say so in review.'
	);
	process.exit(1);
}
