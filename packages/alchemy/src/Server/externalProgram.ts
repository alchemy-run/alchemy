import type * as Path from "effect/Path";

/** Extra-file dest that means "merge this directory into the image/unit root". */
export const CONTEXT_ROOT_DEST = ".";

export const isContextRootDest = (dest: string): boolean =>
  dest === "." || dest === "";

/**
 * Hash extra-file trees without gitignore (a parent `dist` rule would
 * empty the hash) but skip the directories that make a recursive glob
 * unbounded.
 */
export const EXTRA_FILES_HASH_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/cache/**",
  "**/.alchemy/**",
];

const posix = (value: string): string => value.replaceAll("\\", "/");

/**
 * Path of `file` relative to `root`, POSIX. Empty string if they are the
 * same directory. Returns `undefined` when `file` is not under `root`.
 */
export const posixRelUnder = (
  root: string,
  file: string,
  path: {
    readonly resolve: (...segments: string[]) => string;
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
): string | undefined => {
  const from = posix(path.resolve(root));
  const to = posix(path.resolve(file));
  const rel = posix(path.relative(from, to));
  if (rel === "") return "";
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    return undefined;
  }
  return rel;
};

export const contextRootOf = (
  main: string,
  extraFiles: ReadonlyArray<{ source: string; dest: string }>,
  path: Path.Path,
  resolveSource: (source: string) => string,
): string => {
  const root = extraFiles.find((file) => isContextRootDest(file.dest));
  return root !== undefined ? resolveSource(root.source) : path.dirname(main);
};
