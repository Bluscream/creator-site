/**
 * Builds and serves the site for the browser tests, in an environment nobody's machine can change.
 *
 * ### Why this script exists
 *
 * A browser test asserting that an unconfigured install offers no sign-in button passed for months
 * on every machine without Discord credentials — and then failed the moment Twitch became a second
 * sign-in platform, because this developer's **shell** exports real `TWITCH_CLIENT_ID` and
 * `TWITCH_CLIENT_SECRET`. It would have passed in CI and failed only locally, which is the hardest
 * kind of failure to believe and the easiest to dismiss as flakiness.
 *
 * So the browser tests do not run against "whatever this machine is configured as". They run
 * against the install described here.
 *
 * ### Why the configuration is in this file and not in an env file
 *
 * Two reasons, and the second is the real one.
 *
 * Vite's `envDir` can point the build at a different `.env`, but `process.env` is merged in
 * regardless — and that is where these values actually were — so an env file would not have fixed
 * the bug at all. The process has to be cleaned, which only a wrapper can do.
 *
 * And a committed file named `.env` is forbidden by `check-staged-files.js`, correctly: that guard
 * exists so a real environment file cannot be added by a `git add -f` or a stray rename, and
 * carving an exception into it to make a test convenient would be trading a standing protection for
 * a one-off. Plain assignments in a reviewed script are clearer anyway — nobody mistakes this for
 * somewhere to put a credential.
 *
 * ### Why the cleared list comes from `.env.example`
 *
 * Derived rather than hard-coded, because a hard-coded list is correct until somebody adds a
 * variable. `.env.example` is the committed, documented surface of everything this application
 * reads — the house rule is that a new variable goes in it — so a new credential is cleared here
 * automatically instead of quietly configuring the test server.
 *
 * Variables outside that surface are left alone: `PATH`, `HOME` and the rest are how the build runs
 * at all.
 *
 * ### What it is not
 *
 * Not a secret store and not a sandbox. It removes values so the tests see a known install; it
 * protects nothing, and no real credential may ever be written below.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Lines like `NAME=` or `# NAME=`, which is how `.env.example` documents both set and unset. */
const DECLARED = /^#?\s*([A-Z][A-Z0-9_]*)=/;

/**
 * The install the browser tests assert against.
 *
 * Deliberately minimal: no platform credentials and no `SECRET_KEY`, so the tests see the
 * *unconfigured* branch of every page — no sign-in buttons, no linkable platforms. The cases where
 * something **is** configured are unit tests, which can mock one variable at a time instead of
 * rebuilding a server.
 *
 * `DATA_DIR` is the one that matters for safety rather than correctness. Left unset, the server
 * would fall back to the application's own default, which on a developer's machine is the directory
 * their real database, cache and log live in — so the browser tests would write into it. A path
 * under the repository instead, and `.gitignore` covers it.
 */
const INSTALL = {
	// A filesystem path, not a URL, despite the name: it reaches `better-sqlite3` as a filename. A
	// `file:` prefix here made it look for a directory called `file:.`, which SQLite reports as
	// `unable to open database file` — indistinguishable from a permission problem. `db/index.ts` now
	// accepts both spellings, and this stays the documented one.
	DATABASE_URL: '.e2e-data/e2e.db',
	DATA_DIR: '.e2e-data',

	// Quieter than the default, because a build plus a server plus 37 tests of request logging is
	// noise that hides the one line that matters when something fails.
	LOG_LEVEL: 'warn'
};

/**
 * Every variable this application reads, as `.env.example` declares them.
 *
 * @returns {Set<string>}
 */
function declaredNames() {
	const text = readFileSync(join(root, '.env.example'), 'utf8');
	/** @type {Set<string>} */
	const names = new Set();

	for (const line of text.split('\n')) {
		const match = DECLARED.exec(line);

		if (match?.[1] !== undefined) names.add(match[1]);
	}

	if (names.size === 0) {
		// A changed `.env.example` format would silently clean nothing and bring the ambient
		// environment back — which is exactly the bug this script exists to prevent, so it fails
		// loudly rather than running a test suite whose premises are not what it thinks.
		throw new Error('.env.example declared no variables; refusing to run with a dirty environment');
	}

	return names;
}

/**
 * This environment, minus everything the application reads, plus the install above.
 *
 * Built by selecting what survives rather than by deleting from a copy: the names come from a file,
 * so deleting by them is deleting a computed key, and a typo in `.env.example` would silently clear
 * nothing. Filtering states the rule once and cannot half-apply it.
 *
 * @returns {Record<string, string | undefined>}
 */
function environment() {
	const declared = declaredNames();
	const kept = Object.entries(process.env).filter(([name]) => !declared.has(name));

	return { ...Object.fromEntries(kept), ...INSTALL };
}

/**
 * One command, to completion.
 *
 * `spawn` with an argv array rather than a shell string: nothing here is external input today, and
 * a script that builds a shell command is a script somebody later interpolates into.
 */
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<void>}
 */
function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], { cwd: root, env, stdio: 'inherit' });

		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (signal !== null) reject(new Error(`${command} was killed by ${signal}`));
			else if (code === 0) resolve();
			else reject(new Error(`${command} exited with ${String(code)}`));
		});
	});
}

/**
 * A data directory that exists and is empty.
 *
 * Empty because a database left behind by the previous run would carry its accounts: the first
 * account to sign in owns the install, so a stale file is a different install from the one the
 * tests describe — the same class of bug as reading the ambient environment, one run later.
 *
 * The path is fixed and inside the repository, built from this file's own location rather than from
 * anything passed in.
 */
function freshDataDirectory() {
	const path = join(root, '.e2e-data');

	rmSync(path, { recursive: true, force: true });

	// SQLite will create the file but not the directory holding it.
	mkdirSync(path, { recursive: true });
}

freshDataDirectory();

const env = environment();

// Build, then serve, both in the same environment: `$app/env/private` is baked in at build time,
// while the server still reads some of it at run time, so a difference between the two would be a
// server configured differently from the build it is serving.
await run('npx', ['vite', 'build'], env);
await run('npx', ['vite', 'preview'], env);
