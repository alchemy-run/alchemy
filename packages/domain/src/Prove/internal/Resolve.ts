import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** What a `package.json` says of how its package is imported. */
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    main: Schema.optional(Schema.String),
    module: Schema.optional(Schema.String),
    exports: Schema.optional(Schema.Unknown),
  }),
);

interface Package {
  readonly dir: string;
  readonly main: string | undefined;
  readonly exports: unknown;
}

export interface Resolver {
  /** The file a relative specifier names, from the file that imports it. */
  readonly relative: (from: string, specifier: string) => Effect.Effect<string>;
  /**
   * The file a package specifier names, from the file that imports it, as
   * Node finds it: in the nearest `node_modules` that has the package,
   * through its `exports`. `undefined` when nothing is found.
   */
  readonly bare: (from: string, specifier: string) => Effect.Effect<string | undefined>;
}

/** The package a specifier names, and the path inside it: `@acme/rules/Ticket` is `./Ticket` of `@acme/rules`. */
export const packageOf = (
  specifier: string,
): { readonly name: string; readonly subpath: string } | undefined => {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some((part) => part === "")) return undefined;
  const rest = parts.slice(count).join("/");
  return { name: parts.slice(0, count).join("/"), subpath: rest === "" ? "." : `./${rest}` };
};

const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/** The path a target of `exports` names under the conditions the code runs with. */
const targetOf = (
  target: unknown,
  conditions: ReadonlySet<string>,
  star: string | undefined,
): string | undefined => {
  if (typeof target === "string") return star === undefined ? target : target.replaceAll("*", star);
  if (Array.isArray(target)) {
    for (const one of target) {
      const found = targetOf(one, conditions, star);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(target)) return undefined;
  // The first condition that applies, in the order the package wrote them.
  for (const [condition, inner] of Object.entries(target)) {
    if (!conditions.has(condition)) continue;
    const found = targetOf(inner, conditions, star);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A key of `exports` that names this path: itself, or the longest pattern with a `*`. */
const entryOf = (
  entries: Readonly<Record<string, unknown>>,
  wanted: string,
): { readonly target: unknown; readonly star: string | undefined } | undefined => {
  if (Object.hasOwn(entries, wanted) && !wanted.includes("*"))
    return { target: entries[wanted], star: undefined };
  let best: { readonly key: string; readonly star: string } | undefined;
  for (const key of Object.keys(entries)) {
    const at = key.indexOf("*");
    if (at < 0) continue;
    const before = key.slice(0, at);
    const after = key.slice(at + 1);
    if (
      wanted.length >= key.length &&
      wanted.startsWith(before) &&
      wanted.endsWith(after) &&
      (best === undefined || before.length > best.key.indexOf("*"))
    )
      best = { key, star: wanted.slice(before.length, wanted.length - after.length) };
  }
  return best ? { target: entries[best.key], star: best.star } : undefined;
};

/** Finds the files that imports name, the way the runtime that runs the code does. */
export const make: Effect.Effect<Resolver, never, FileSystem.FileSystem | Path.Path> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const conditions = new Set([
      ...(yield* Effect.sync(() => (process.versions.bun === undefined ? [] : ["bun"]))),
      "node",
      "import",
      "module-sync",
      "default",
    ]);
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    const packages = new Map<string, Package | undefined>();

    const manifest = Effect.fn(function* (dir: string) {
      if (packages.has(dir)) return packages.get(dir);
      const made = yield* fs.readFileString(path.join(dir, "package.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Manifest)),
        Effect.map((read): Package => ({
          dir,
          main: read.module ?? read.main,
          exports: read.exports,
        })),
        Effect.orElseSucceed(() => undefined),
      );
      packages.set(dir, made);
      return made;
    });

    /** The directories from a file's own up to the root. */
    const above = (from: string): ReadonlyArray<string> => {
      const dirs: Array<string> = [];
      for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
        dirs.push(dir);
        if (path.dirname(dir) === dir) return dirs;
      }
    };

    const relative: Resolver["relative"] = Effect.fn(function* (from: string, specifier: string) {
      const base = path.resolve(path.dirname(from), specifier);
      if (/\.[cm]?[jt]sx?$/.test(base)) return base;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, path.resolve(base, "index.ts")]) {
        if (yield* exists(candidate)) return candidate;
      }
      return base;
    });

    /** A path inside a package, as a file: links followed, as the runtime follows them. */
    const inside = Effect.fn(function* (dir: string, target: string | undefined) {
      if (target === undefined || !target.startsWith("./")) return undefined;
      const file = yield* relative(path.join(dir, "package.json"), target);
      if (!(yield* exists(file))) return undefined;
      return yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
    });

    const bare: Resolver["bare"] = Effect.fn(function* (from: string, specifier: string) {
      const named = packageOf(specifier);
      if (!named) return undefined;
      let found: Package | undefined;
      for (const dir of above(from)) {
        if (path.basename(dir) === "node_modules") continue;
        found = yield* manifest(path.join(dir, "node_modules", named.name));
        if (found) break;
      }
      if (!found) return undefined;
      if (found.exports === undefined)
        return yield* inside(
          found.dir,
          named.subpath === "."
            ? `./${(found.main ?? "index.js").replace(/^\.\//, "")}`
            : named.subpath,
        );
      // `exports` is either the paths it gives, or what `.` gives under each condition.
      const paths =
        isRecord(found.exports) && Object.keys(found.exports).every((key) => key.startsWith("."))
          ? found.exports
          : { ".": found.exports };
      const entry = entryOf(paths, named.subpath);
      return entry
        ? yield* inside(found.dir, targetOf(entry.target, conditions, entry.star))
        : undefined;
    });

    return { relative, bare };
  },
);
