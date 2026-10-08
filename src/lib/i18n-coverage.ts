/**
 * The two i18n checks that need to look at the *source*, not at the catalogues.
 *
 * `i18n.test.ts` covers everything comparable between two catalogue files: a missing key, an
 * untranslated string, a lost placeholder, a misnamed key. Neither of the failures here is visible
 * from there, and both were carried as known gaps in the README until there was a UI to check.
 *
 * ### 1. A string that never went through `m.*` at all
 *
 * The exact failure that shipped in the PHP admin: headings and placeholders rendered English on a
 * German page, and nothing reported it, because from the catalogue's point of view nothing was
 * wrong — the string was never a key. A type checker cannot see it either. It needs someone to look
 * at the markup, which is what this does.
 *
 * ### 2. A catalogue key nothing refers to
 *
 * Dead weight that a translator still pays for. Left out while the catalogue ran ahead of the UI,
 * since every key would have been reported; now that pages exist it is worth knowing.
 *
 * ### Why the Svelte compiler and not a regular expression
 *
 * A component is not a regular language. A regex over markup has to decide whether `<!-- Save -->`
 * is a comment, whether `class="Save me"` is an attribute, and whether `'Save'` inside the `<script>`
 * block is markup — and gets at least one of them wrong, which means either false reports that
 * train people to ignore it or false silence that defeats the point. `svelte/compiler` already
 * knows, and it is the same parser the build uses, so the two cannot disagree.
 */

import { parse } from 'svelte/compiler';

/** One piece of text in markup that no message function produced. */
export interface HardcodedString {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

/**
 * Text that is allowed to sit in markup untranslated.
 *
 * Deliberately short. Each entry is a thing that reads the same in every language this project
 * supports, and a list that grows is a sign the check is being worked around rather than used.
 */
const NOT_WORDS = /^[\s\p{P}\p{S}\d]*$/u;

/**
 * Elements whose text content is not shown to a reader.
 *
 * `<style>` and `<script>` are not markup. `<title>` *is* read, so it is deliberately absent.
 */
const NON_TEXT_ELEMENTS = new Set(['style', 'script']);

interface Node {
	readonly type: string;
	readonly name?: string;
	readonly data?: string;
	readonly start?: number;
	readonly fragment?: { readonly nodes?: readonly Node[] };
	readonly nodes?: readonly Node[];
}

/** The 1-based line a character offset falls on. */
function lineOf(source: string, offset: number): number {
	return source.slice(0, offset).split('\n').length;
}

/**
 * Every run of visible text in a component's markup.
 *
 * Walks the template fragment only. The `<script>` block is a separate branch of the AST and is
 * never entered, so a string literal in code is not mistaken for a label — which is the single
 * thing a regex over the file cannot get right.
 */
export function hardcodedStrings(file: string, source: string): readonly HardcodedString[] {
	const found: HardcodedString[] = [];

	const ast = parse(source, { modern: true }) as unknown as { fragment: Node };

	const visit = (node: Node, inside: string | null): void => {
		if (node.type === 'Text') {
			const text = (node.data ?? '').trim();

			// Punctuation, digits and symbols alone are not words: a separator, a bullet or an
			// arithmetic sign reads the same in German as in English.
			if (text !== '' && !NOT_WORDS.test(text) && inside === null) {
				found.push({ file, line: lineOf(source, node.start ?? 0), text });
			}

			return;
		}

		const name = node.name ?? '';
		const next = node.type === 'RegularElement' && NON_TEXT_ELEMENTS.has(name) ? name : inside;

		for (const child of node.fragment?.nodes ?? node.nodes ?? []) visit(child, next);
	};

	visit(ast.fragment, null);

	return found;
}

/**
 * Every message key the source refers to, as a `m.<key>(…)` call.
 *
 * A regex is the right tool *here*, unlike in the markup: this looks for one unambiguous call shape
 * in already-valid TypeScript, and the alternative — type-checking every file to resolve the import
 * — would be a compiler pass to find a dotted name.
 *
 * The cost is that a key reached dynamically, `m[name]()`, is invisible. Nothing does that, and if
 * something ever does it will have to be exempted explicitly, which is the right outcome: a
 * catalogue whose keys are assembled at runtime cannot be checked by anything.
 *
 * The other cost was worse and is now checked separately: a file importing the catalogue under any
 * other name — `import * as paraglide from …` — had every one of its calls invisible here, so the
 * keys it used were reported as dead and the keys it *missed* were reported as covered. See
 * {@link aliasedImports}, which refuses the alias rather than trying to follow it.
 */
export function referencedKeys(sources: readonly string[]): ReadonlySet<string> {
	const keys = new Set<string>();

	for (const source of sources) {
		for (const match of source.matchAll(/\bm\.([a-z][a-z0-9_]*)\s*\(/g)) {
			const key = match[1];

			if (key !== undefined) keys.add(key);
		}
	}

	return keys;
}

/**
 * The import that would hide a call from {@link referencedKeys}, if there is one.
 *
 * `referencedKeys` finds `m.<key>()` and nothing else, so a file that imports the catalogue as
 * anything but `m` makes its messages invisible: they come out of the coverage check as dead keys,
 * and a key it genuinely forgot comes out as covered. That happened, with nine keys, which is how
 * this function came to exist.
 *
 * Refusing the alias rather than following it. Matching a second name would mean matching every
 * name, which is a compiler pass; and there is no reason for a second name — the catalogue is `m`
 * everywhere in this project, and the one convention is worth more than the freedom.
 *
 * @returns each offending import as it was written, for an error message that can be acted on
 */
export function aliasedImports(sources: readonly string[]): readonly string[] {
	const found: string[] = [];

	for (const source of sources) {
		for (const match of source.matchAll(
			/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]*paraglide\/messages[^'"]*['"]/g
		)) {
			if (match[1] !== 'm') found.push(match[0]);
		}
	}

	return found;
}
