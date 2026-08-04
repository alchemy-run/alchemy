import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import path from "pathe";

/**
 * Convert a Worker `main` entry (a plain path or a `file://` URL) to a
 * filesystem path, without resolving it.
 *
 * Internal to `Workers/Sources/` — not exported from the package index.
 */
export const mainToPath = (main: string) =>
  Effect.sync(() => {
    try {
      return fileURLToPath(main);
    } catch {
      return main;
    }
  });

/**
 * Resolve a Worker `main` entry (path or `file://` URL) to an absolute
 * path without following symlinks (Alchemy v1 parity): the module walk
 * happens in the directory the user pointed at, not the entry's
 * canonical location.
 *
 * Internal to `Workers/Sources/` — not exported from the package index.
 */
export const resolveMainPath = (main: string) =>
  mainToPath(main).pipe(Effect.map((p) => path.resolve(p)));
