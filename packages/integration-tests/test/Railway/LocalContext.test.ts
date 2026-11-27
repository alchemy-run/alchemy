import { gunzipSync } from "node:zlib";
import {
  hashRailwayLocalContext,
  prepareRailwayLocalContext,
} from "@alchemy.run/railway/local-context";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

// A pnpm workspace whose packages depend on each other: `a/node_modules/b`
// links to `b`, and `b/node_modules/a` back to `a`, a symlink cycle.
const makeWorkspace = Effect.fn(function* (ignore: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-railway-context-" });
  yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nCOPY . /app\n");
  yield* fs.writeFileString(path.join(root, ".dockerignore"), ignore);
  for (const [name, dependency] of [
    ["a", "b"],
    ["b", "a"],
  ] as const) {
    const modules = path.join(root, "packages", name, "node_modules");
    yield* fs.makeDirectory(modules, { recursive: true });
    yield* fs.writeFileString(path.join(root, "packages", name, "index.js"), name);
    yield* fs.symlink(`../../${dependency}`, path.join(modules, dependency));
  }
  return { root, fs, path };
});

layer(BunServices.layer)("Railway local context", (test) => {
  test.effect(
    "prunes ignored node_modules without following symlink cycles",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeWorkspace("**/node_modules\n");
        const reads: string[] = [];
        const guarded: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (directory, options) => {
            reads.push(path.relative(root, directory));
            return fs.readDirectory(directory, options);
          },
          readDirectoryEntries: (directory) => {
            reads.push(path.relative(root, directory));
            return fs.readDirectoryEntries(directory);
          },
        };

        const hash = yield* hashRailwayLocalContext({ context: root }).pipe(
          Effect.provideService(FileSystem.FileSystem, guarded),
        );
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
        expect(reads.filter((read) => read.includes("node_modules"))).toEqual([]);

        const prepared = yield* prepareRailwayLocalContext({ context: root });
        expect(prepared.codeHash).toBe(hash);
      }).pipe(Effect.scoped),
    { tags: ["unit", "provider:railway", "local"] },
  );

  test.effect(
    "uploads a directory whose contents are ignored as an empty directory",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeWorkspace("**/node_modules\ncache/**\n");
        yield* fs.makeDirectory(path.join(root, "cache", "sub"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "cache", "sub", "data"), "ignored");

        const prepared = yield* prepareRailwayLocalContext({ context: root });
        const tar = yield* Effect.sync(() => gunzipSync(prepared.tarball).toString("latin1"));
        expect(tar).toContain("cache/\0");
        expect(tar).not.toContain("cache/sub");
      }).pipe(Effect.scoped),
    { tags: ["unit", "provider:railway", "local"] },
  );

  test.effect(
    "rejects a symlink the upload would include",
    () =>
      Effect.gen(function* () {
        const { root } = yield* makeWorkspace("");
        const result = yield* Effect.result(hashRailwayLocalContext({ context: root }));
        expect(Result.isFailure(result) && result.failure._tag).toBe(
          "Railway.ServiceContextSymlinkUnsupported",
        );
      }).pipe(Effect.scoped),
    { tags: ["unit", "provider:railway", "local"] },
  );
});
