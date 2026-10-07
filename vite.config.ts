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
