import { Ignore } from "@alchemy.run/node-utils/ignore";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import * as NodeCrypto from "node:crypto";

// Lockfiles are hashed in addition to the tracked files so that a dependency
// change (which mutates the lockfile but not the source) still busts the cache.
// Ordered by preference — the first one found walking up from the dir wins.
const LOCKFILES = [
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
];

export class BuildCache extends Context.Service<
  BuildCache,
  {
    readonly hashDirectory: (
      dir: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, PlatformError>;
  }
>()("@alchemy/BuildCache") {}

export const BuildCacheLive = Layer.effect(
  BuildCache,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const hashFile = (path: string) =>
      Effect.map(fs.readFile(path), (content) =>
        NodeCrypto.createHash("sha256").update(content).digest("hex"),
      );

    const readGitIgnore = (dir: string) =>
      fs.readFileString(path.join(dir, ".gitignore")).pipe(
        Effect.map((content) =>
          content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#")),
        ),
        Effect.orElseSucceed(() => undefined),
      );

    const findUp = yield* cachedFunction(
      (
        dir: string,
        filenames: string[],
      ): Effect.Effect<string | undefined, PlatformError> =>
        Effect.forEach(
          filenames,
          (filename) => {
            const filepath = path.join(dir, filename);
            return fs.stat(filepath).pipe(
              Effect.map((info) =>
                info.type === "File" || info.type === "Directory"
                  ? filepath
                  : undefined,
              ),
              // A missing entry is not an error — it just means "keep looking".
              Effect.orElseSucceed(() => undefined),
            );
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap((matches) => {
            const match = matches.find((match) => match !== undefined);
            if (match) {
              return Effect.succeed(match);
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
              return Effect.succeed(undefined);
            }
            return findUp(parent, filenames);
          }),
        ),
    );

    const findWorkspaceRoot = yield* cachedFunction((dir: string) =>
      Effect.map(findUp(dir, [".git"]), (file) =>
        file ? path.dirname(file) : dir,
      ),
    );

    const buildIgnoreMatcher = (root: string, dir: string) => {
      const paths: string[] = [];
      let current = dir;
      while (current !== root) {
        paths.push(current);
        current = path.dirname(current);
      }
      paths.push(root);
      return Effect.forEach(paths, readGitIgnore, {
        concurrency: "unbounded",
      }).pipe(
        Effect.map((ignores) => {
          const ignore = new Ignore().add([".git", ".gitignore"]);
          for (let i = ignores.length - 1; i >= 0; i--) {
            if (ignores[i]) {
              ignore.add(ignores[i]);
            }
          }
          return ignore;
        }),
      );
    };

    interface DirectoryMetadata {
      readonly root: string;
      readonly dir: string;
      readonly ignore: Ignore;
    }

    const hashFiles = (
      acc: Map<string, string>,
      files: string[],
      metadata: DirectoryMetadata,
    ): Effect.Effect<ReadonlyMap<string, string>, PlatformError> =>
      Effect.forEach(
        files,
        (file) => {
          const absolutePath = path.join(metadata.dir, file);
          const relativePath = path.relative(metadata.root, absolutePath);
          if (metadata.ignore.ignores(relativePath)) {
            return Effect.void;
          }
          return Effect.flatMap(fs.stat(absolutePath), (info) => {
            if (info.type === "File") {
              return hashFile(absolutePath).pipe(
                Effect.tap((hash) =>
                  Effect.sync(() => acc.set(relativePath, hash)),
                ),
              );
            } else if (info.type === "Directory") {
              return hashChildDirectory(acc, absolutePath, metadata);
            }
            return Effect.void;
          });
        },
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.as(acc));

    const hashChildDirectory = (
      acc: Map<string, string>,
      dir: string,
      metadata: DirectoryMetadata,
    ): Effect.Effect<ReadonlyMap<string, string>, PlatformError> =>
      Effect.all(
        [
          fs.readDirectory(dir),
          readGitIgnore(dir).pipe(
            Effect.map((rules) =>
              rules
                ? new Ignore().add(metadata.ignore).add(rules)
                : metadata.ignore,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([files, ignore]) =>
          hashFiles(acc, files, {
            root: metadata.root,
            dir,
            ignore,
          }),
        ),
      );

    const hashLockfile = (dir: string) =>
      findUp(dir, LOCKFILES).pipe(
        Effect.flatMap((name) =>
          name === undefined
            ? Effect.succeed(undefined)
            : hashFile(name).pipe(Effect.map((hash) => ({ name, hash }))),
        ),
      );

    return BuildCache.of({
      hashDirectory: (dir) =>
        findWorkspaceRoot(dir).pipe(
          Effect.flatMap((root) =>
            Effect.all(
              [
                fs.readDirectory(dir),
                buildIgnoreMatcher(root, dir),
                hashLockfile(dir),
              ],
              { concurrency: "unbounded" },
            ).pipe(
              Effect.flatMap(([files, ignore, lockfile]) => {
                const acc = new Map<string, string>();
                return hashFiles(acc, files, { root, dir, ignore }).pipe(
                  Effect.map(() => {
                    if (lockfile) {
                      acc.set(path.relative(root, lockfile.name), lockfile.hash);
                    }
                    return acc;
                  }),
                );
              }),
            ),
          ),
        ),
    });
  }),
);

const cachedFunction = <
  F extends (...args: any[]) => Effect.Effect<any, any, any>,
>(
  fn: F,
): Effect.Effect<F> =>
  Cache.make({
    lookup: (args: Parameters<F>) => fn(...args),
    capacity: Infinity,
    requireServicesAt: "lookup",
  }).pipe(
    Effect.map(
      (cache) => ((...args: Parameters<F>) => Cache.get(cache, args)) as F,
    ),
  );
