// See https://svelte.dev/docs/kit/types#app.d.ts for information about these interfaces.
declare global {
	// SvelteKit's ambient types are keyed on a global `App` namespace — `Locals`, `PageData` and
	// the rest are only found here, and there is no module form of this declaration. The ban on
	// namespaces stands everywhere else in the project.
	// eslint-disable-next-line no-restricted-syntax -- required by SvelteKit, see above
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
