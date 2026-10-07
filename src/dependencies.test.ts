/**
 * That `package.json` and what the source actually imports agree.
 *
 * ### The mistake this exists to catch
 *
 * `drizzle-orm` sat in `devDependencies` while `src/lib/server/db/index.ts` imported it as runtime
 * code. Nothing caught it: the type checker resolves `devDependencies` perfectly well, every test
 * passed, and the container built and served requests — because no feature imports the database
 * module yet, so the bundler never put it in the server build. It would have surfaced as a
 * `Cannot find package 'drizzle-orm'` on somebody's server, on the first request after the first
 * feature that stored anything.
 *
 * That failure mode is structural: `npm ci --omit=dev` in the runtime stage of the `Dockerfile`
 * installs `dependencies` only, so a runtime import of a dev dependency is always a production
 * crash, and never a local one. A test is the only thing that sees it, because locally the package
 * is right there.
 *
 * ### Both directions
 *
 * A dependency that nothing imports is also worth failing on — it is weight in every install and
 * an entry in the audit surface for nothing. The two checks together keep the manifest honest in
 * both directions.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * Packages that belong in `devDependencies` *despite* being imported by shipped source, because
 * the bundler inlines them rather than importing them at runtime.
 *
 * Must stay in step with `ssr.noExternal` in `vite.config.ts`, which is asserted below rather than
 * trusted.
 */
const BUNDLED = ['lucide', 'simple-icons'];

/**
 * The framework itself, which SvelteKit's build inlines into the server output.
 *
 * Separate from {@link BUNDLED} because this is not something `ssr.noExternal` configures — it is
 * what the adapter does, and there is no line in `vite.config.ts` to check it against. Verified
 * directly instead: neither package is present in `node_modules` in the built container image, and
 * every route serves, so the runtime genuinely does not import them.
 */
const FRAMEWORK = ['svelte', '@sveltejs/kit'];

/** Prefixes that are not packages: framework aliases, this project's own subpath imports, Node. */
const NOT_A_PACKAGE = ['$app/', '$lib', '$env/', '#lib', '#shared', '#server', 'node:'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);

/**
 * Every shipped source file.
 *
 * Excludes unit tests, browser tests and Playwright specs, all of which may import anything from
 * `devDependencies` — they never run on a deployed server.
 */
function sourceFiles(): readonly string[] {
	return readdirSync('src', { recursive: true, encoding: 'utf8' })
		.map((entry) => join('src', entry))
		.filter(
			(path) =>
				SOURCE_EXTENSIONS.has(extname(path)) &&
				!/\.(test|spec|e2e)\.[tj]s$/.test(path) &&
				// Generated at build time from the inlang project, not written by hand.
				!path.startsWith(join('src', 'lib', 'paraglide'))
		);
}

/**
 * The package names a file imports at runtime.
 *
 * Type-only imports are skipped: they are erased by the compiler, so `@types/*` and similar
 * correctly live in `devDependencies`. A subpath import (`drizzle-orm/better-sqlite3`) is reduced
 * to the package that provides it, scope included.
 */
function importsOf(source: string): readonly string[] {
	const specifiers = [
		...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^;]*?)from\s*'([^']+)'/g)
	]
		.filter(([, clause]) => clause !== undefined && !/^type\s/.test(clause.trim()))
		.map(([, , specifier]) => specifier ?? '');

	return specifiers
		.filter(
			(specifier) =>
				!specifier.startsWith('.') && !NOT_A_PACKAGE.some((p) => specifier.startsWith(p))
		)
		.map((specifier) => {
			const parts = specifier.split('/');

			return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
		});
}

/** Every package imported by shipped source, and one file that imports each, for the message. */
function importedPackages(): ReadonlyMap<string, string> {
	const found = new Map<string, string>();

	for (const path of sourceFiles()) {
		for (const name of importsOf(readFileSync(path, 'utf8'))) {
			if (!found.has(name)) found.set(name, path);
		}
	}

	return found;
}

const production = Object.keys(manifest.dependencies);
const development = Object.keys(manifest.devDependencies);

describe('production dependencies', () => {
	it('include every package that shipped source imports at runtime', () => {
		const missing = [...importedPackages()]
			.filter(
				([name]) =>
					!production.includes(name) && !BUNDLED.includes(name) && !FRAMEWORK.includes(name)
			)
			.map(([name, path]) => `${name} (imported by ${path})`);

		expect(missing).toStrictEqual([]);
	});

	it('are all actually imported', () => {
		const imported = importedPackages();

		expect(production.filter((name) => !imported.has(name))).toStrictEqual([]);
	});

	it('do not include the packages the build inlines', () => {
		// These are imported by shipped source *and* belong in `devDependencies` — the one case the
		// first assertion has to forgive. Checked so that the exemption cannot quietly become a way
		// for a genuinely-needed package to stay in `devDependencies`.
		expect(BUNDLED.filter((name) => production.includes(name))).toStrictEqual([]);
		expect(BUNDLED.filter((name) => !development.includes(name))).toStrictEqual([]);
	});

	it('exempt exactly the packages vite.config.ts marks as noExternal', () => {
		// The exemption list above is only correct because Vite bundles these. If someone removes a
		// package from `ssr.noExternal` without moving it back to `dependencies`, the build starts
		// importing it at runtime and it will not be installed — so the two lists must match.
		const config = readFileSync('vite.config.ts', 'utf8');
		const declared = /noExternal:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';

		expect([...declared.matchAll(/'([^']+)'/g)].map(([, name]) => name)).toStrictEqual(BUNDLED);
	});
});
