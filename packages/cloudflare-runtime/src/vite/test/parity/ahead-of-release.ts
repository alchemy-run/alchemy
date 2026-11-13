/**
 * Behavior ported from upstream `main` before a `@cloudflare/vite-plugin`
 * release ships it. The differential tests ignore these until the installed
 * release catches up; delete an entry once it does.
 */

/** Runtime built-in modules (`cloudflare:*`) upstream added after the release. */
export const AHEAD_OF_RELEASE_BUILT_IN_MODULES: ReadonlyArray<string> = [];
