import {
  hashDirectory,
  hashViteBuildInputs,
  resolveWorkspaceClosure,
} from "@/Command/Memo";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Builds a small monorepo under a temp dir:
//
//   root/                 workspaces: ["packages/*"]
//   packages/app          -> depends on @scope/lib-a
//   packages/lib-a        -> depends on @scope/lib-b (and back on lib-a: cycle)
//   packages/lib-b        -> depends on @scope/lib-a (cycle)
//   packages/lib-c        -> unrelated, nothing depends on it
//
// The app's workspace closure is therefore {@scope/lib-a, @scope/lib-b}.
const makeWorkspace = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-memo-" });

  const write = (relativePath: string, content: string) =>
    Effect.gen(function* () {
      const absolute = path.join(root, relativePath);
      yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
      yield* fs.writeFileString(absolute, content);
    });

  yield* write(
    "package.json",
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  yield* write("bun.lock", "{}");

  yield* write(
    "packages/app/package.json",
    JSON.stringify({
      name: "app",
      dependencies: { "@scope/lib-a": "workspace:*" },
    }),
  );
  yield* write("packages/app/src/index.ts", "export const app = 1;\n");
  yield* write("packages/app/ignored.txt", "not part of src\n");

  yield* write(
    "packages/lib-a/package.json",
    JSON.stringify({
      name: "@scope/lib-a",
      dependencies: { "@scope/lib-b": "workspace:*" },
    }),
  );
  yield* write("packages/lib-a/src/a.ts", "export const a = 1;\n");

  yield* write(
    "packages/lib-b/package.json",
    JSON.stringify({
      name: "@scope/lib-b",
      // Cycle back to lib-a to exercise cycle-safety of the closure walk.
      dependencies: { "@scope/lib-a": "workspace:*" },
    }),
  );
  yield* write("packages/lib-b/src/b.ts", "export const b = 1;\n");

  yield* write(
    "packages/lib-c/package.json",
    JSON.stringify({ name: "@scope/lib-c" }),
  );
  yield* write("packages/lib-c/src/c.ts", "export const c = 1;\n");

  return {
    root,
    appDir: path.join(root, "packages", "app"),
    edit: (relativePath: string, content: string) =>
      write(relativePath, content),
  };
});

describe("resolveWorkspaceClosure", () => {
  it.effect("resolves the transitive workspace dependency closure", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workspace = yield* makeWorkspace();

      const closure = yield* resolveWorkspaceClosure(workspace.appDir);

      // Sorted by name, excludes the app itself and the unrelated lib-c,
      // and terminates despite the lib-a <-> lib-b cycle.
      expect(closure.map((pkg) => pkg.name)).toEqual([
        "@scope/lib-a",
        "@scope/lib-b",
      ]);
      expect(closure.map((pkg) => path.resolve(pkg.dir))).toEqual([
        path.resolve(path.join(workspace.root, "packages", "lib-a")),
        path.resolve(path.join(workspace.root, "packages", "lib-b")),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an empty closure outside a workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-memo-solo-",
      });
      yield* fs.writeFileString(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "solo", dependencies: { effect: "^4" } }),
      );

      expect(yield* resolveWorkspaceClosure(dir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("hashViteBuildInputs", () => {
  it.effect("changes when a transitive workspace dependency changes", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace();

      const before = yield* hashViteBuildInputs({ cwd: workspace.appDir });
      yield* workspace.edit("packages/lib-b/src/b.ts", "export const b = 2;\n");
      const after = yield* hashViteBuildInputs({ cwd: workspace.appDir });

      expect(after).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is unchanged when an unrelated workspace package changes", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace();

      const before = yield* hashViteBuildInputs({ cwd: workspace.appDir });
      // lib-c is a workspace package but not in the app's closure.
      yield* workspace.edit("packages/lib-c/src/c.ts", "export const c = 2;\n");
      const after = yield* hashViteBuildInputs({ cwd: workspace.appDir });

      expect(after).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "narrows the rootDir scope via memo.include while still tracking the closure",
    () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        const memo = { include: ["src/**"] };

        const before = yield* hashViteBuildInputs({
          cwd: workspace.appDir,
          memo,
        });

        // A rootDir file outside `include` must not affect the hash.
        yield* workspace.edit(
          "packages/app/ignored.txt",
          "changed but excluded\n",
        );
        expect(
          yield* hashViteBuildInputs({ cwd: workspace.appDir, memo }),
        ).toBe(before);

        // The workspace closure is still hashed regardless of `memo`.
        yield* workspace.edit(
          "packages/lib-a/src/a.ts",
          "export const a = 2;\n",
        );
        expect(
          yield* hashViteBuildInputs({ cwd: workspace.appDir, memo }),
        ).not.toBe(before);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("equals hashDirectory of rootDir when there is no closure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-memo-nodep-",
      });
      yield* fs.writeFileString(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "solo", dependencies: { effect: "^4" } }),
      );
      yield* fs.writeFileString(path.join(dir, "index.ts"), "export {};\n");

      expect(yield* hashViteBuildInputs({ cwd: dir })).toBe(
        yield* hashDirectory({ cwd: dir }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
