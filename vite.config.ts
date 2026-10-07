import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		}),

		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			emitTsDeclarations: true,

			// Precedence, highest first. Each entry answers a different question, and dropping any one
			// of them loses a behaviour the platform requires:
			//
			//   url               an explicit `/de/…` — shareable, crawlable, and cacheable, because
			//                     each language is its own URL rather than one URL that varies by
			//                     request header
			//   cookie            the viewer picked a language, and that choice should outlive the tab
			//   preferredLanguage the browser's Accept-Language, so a first visit already arrives in
			//                     the right language without anyone being asked
			//   baseLocale        English
			strategy: ['url', 'cookie', 'preferredLanguage', 'baseLocale'],

			// The API is not a page and has no language of its own: a client that wants a localized
			// response asks for one explicitly. Without this, `/api/…` would be localized like a
			// route and machine clients would be redirected to `/de/api/…`.
			routeStrategies: [{ match: '/api/:path(.*)?', exclude: true }]
		})
	],
	ssr: {
		// Bundle these into the server build instead of importing them from `node_modules` at
		// runtime.
		//
		// Both are large sets of data — every Lucide glyph, every brand mark in Simple Icons — and
		// `src/lib/icons.ts` imports 21 of them by name. Left external, the server would `import`
		// the packages whole at runtime and 56 MB of icon data would have to be installed beside
		// the build: `lucide` 31 MB and `simple-icons` 25 MB, against a 2.6 MB build. Bundled,
		// Rollup tree-shakes them down to the 21 that are referenced, and both move to
		// `devDependencies` because nothing imports them any more once the build exists.
		//
		// This is only safe for packages that are pure, side-effect-free data or ESM. Do not add
		// `better-sqlite3` here — it is a native addon and must stay external.
		noExternal: ['lucide', 'simple-icons']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
