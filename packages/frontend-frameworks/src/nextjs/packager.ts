/**
 * Package-manager detection shared by the Next.js deploy targets: the
 * default `next build` invocation must run through the runner of the
 * package manager the project actually uses, not a hardcoded `npx`.
 *
 * Mirrored by the sync fallback in `runner.mjs` (which cannot import this
 * module — it ships as a standalone child-process script).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The package manager detected from the project's lockfile. */
export type Packager = "bun" | "npm" | "yarn" | "pnpm";

// Mirrors @opennextjs/aws's findPackagerAndRoot: walk up from the project
// root to the nearest lockfile. bun is checked before yarn because
// `bun install --yarn` can emit a yarn.lock alongside bun's own.
const PACKAGER_LOCKFILES: ReadonlyArray<readonly [string, Packager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
];

/**
 * Detect the project's package manager the same way OpenNext does (nearest
 * lockfile, walking up), so the default build command uses the runner the
 * rest of the build already agreed on. Falls back to npm.
 */
export const detectPackager: (
  root: string,
) => Effect.Effect<Packager, never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = root;
    while (true) {
      for (const [file, packager] of PACKAGER_LOCKFILES) {
        const exists = yield* fs
          .exists(path.join(current, file))
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) return packager;
      }
      const parent = path.dirname(current);
      if (parent === current) return "npm";
      current = parent;
    }
  });

/** The `next build` invocation through the packager's local-binary runner. */
export const defaultBuildCommand = (packager: Packager): string => {
  switch (packager) {
    case "bun":
      return "bunx next build";
    case "pnpm":
      return "pnpm exec next build";
    case "yarn":
      return "yarn next build";
    case "npm":
      return "npx next build";
  }
};
