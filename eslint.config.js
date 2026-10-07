import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/**
 * Size limits, enforced here rather than by eye.
 *
 * A limit nobody checks is a suggestion. ESLint covers both file and function length natively, so
 * there is no need for a separate test counting lines. `max-lines-per-function` is the one that
 * actually catches drift, because a file usually grows by one function growing.
 */
/** @type {import('eslint').Linter.RulesRecord} */
const SIZE_LIMITS = {
	'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
	'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
	'max-params': ['error', 5],
	'max-depth': ['error', 3]
};

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,

	// The pedantic tier, not `recommended`. `strictTypeChecked` is where the rules that need the
	// type checker live — unnecessary assertions, floating promises, unsafe `any` flow — and those
	// are the ones worth having.
	ts.configs.strictTypeChecked,
	ts.configs.stylisticTypeChecked,

	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,

	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			// Type-aware linting across the whole project, not only Svelte files.
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			// typescript-eslint strongly recommend not using no-undef on TypeScript projects: the
			// compiler already answers this question, and better.
			// https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule
			'no-undef': 'off',

			...SIZE_LIMITS,

			// Shipped code logs through a logger with levels, so output can be filtered, routed and
			// silenced. `console.error` stays for the paths that run before a logger exists.
			'no-console': ['error', { allow: ['error'] }],

			// Banned constructs, each with a replacement that keeps type information rather than
			// discarding it.
			'no-restricted-syntax': [
				'error',
				{
					selector: 'TSEnumDeclaration',
					message:
						'Use an `as const` object with a literal union: enums are not erasable and behave unlike the rest of the type system.'
				},
				{ selector: 'TSModuleDeclaration[kind="namespace"]', message: 'Use ES modules.' }
			],

			// An unawaited promise is the most common way an error disappears in this language.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',

			// `@ts-expect-error` fails once the underlying problem is fixed; `@ts-ignore` never
			// does, so it silently outlives its reason.
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-expect-error': 'allow-with-description',
					'ts-ignore': true,
					minimumDescriptionLength: 10
				}
			],

			// `verbatimModuleSyntax` requires the explicit form anyway.
			'@typescript-eslint/consistent-type-imports': 'error'
		}
	},

	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},

	{
		// A test describes scenarios: a long `describe` is one unit of meaning rather than drift,
		// and splitting it to satisfy a line count makes the suite harder to read.
		files: ['**/*.test.ts', '**/*.spec.ts', '**/*.e2e.ts'],
		rules: { 'max-lines-per-function': 'off', 'max-lines': 'off' }
	}
);
