import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { hashInput, type MemoOptions } from "../InputHash.ts";
import { makeWorkerSource, type SourceContext, type SourceHash } from "../WorkerSource.ts";
import { makeProject, run } from "./helpers.ts";

/**
 * A two-package layout: `app/` is the project root and `lib/` a sibling
 * package it imports, which the build reports as an external workspace.
 */
const makeMonorepo = async () => {
  const dir = await makeProject({
    "app/package.json": JSON.stringify({ name: "app" }),
    "app/src/index.ts": `export { greeting } from "../../lib/src/greeting.ts";`,
    "lib/package.json": JSON.stringify({ name: "lib" }),
    "lib/src/greeting.ts": `export const greeting = "hello";`,
  });
  return {
    app: NodePath.join(dir, "app"),
    lib: NodePath.join(dir, "lib"),
    greeting: NodePath.join(dir, "lib", "src", "greeting.ts"),
  };
};

const hash = (rootDir: string, workspaces: Iterable<string>, memo?: MemoOptions) =>
  run(hashInput({ rootDir, outputDirs: ["dist"], memo, workspaces, options: undefined }));

describe("hashInput workspaces", () => {
  it("an edit in a sibling workspace changes the hash (#744)", async () => {
    const { app, greeting } = await makeMonorepo();
    const before = await hash(app, ["../lib"]);
    expect(before.workspaces).toEqual(["../lib"]);
    expect((await hash(app, ["../lib"])).hash).toBe(before.hash);

    await NodeFsPromises.writeFile(greeting, `export const greeting = "hi";`);
    expect((await hash(app, ["../lib"])).hash).not.toBe(before.hash);
  });

  it("hashes a workspace the same whether the build or the state reports it", async () => {
    const { app, lib } = await makeMonorepo();
    // The build reports absolute paths; the state stores root-relative ones.
    const fromBuild = await hash(app, [lib, lib]);
    const fromState = await hash(app, ["../lib"]);
    expect(fromBuild).toEqual(fromState);
  });

  it("skips a recorded workspace that was deleted, so the hash changes (#2606)", async () => {
    const { app, lib } = await makeMonorepo();
    const built = await hash(app, [lib]);
    await NodeFsPromises.rm(lib, { recursive: true });

    const next = await hash(app, built.workspaces ?? []);
    expect(next.workspaces).toEqual([]);
    expect(next.hash).not.toBe(built.hash);
    expect(next.hash).toBe((await hash(app, [])).hash);
  });

  it("skips recorded workspaces that no longer resolve after rootDir moves (#2606)", async () => {
    const { app, lib } = await makeMonorepo();
    const built = await hash(app, [lib]);
    // The app moves one level deeper; the stored `../lib` now points nowhere.
    const moved = NodePath.join(NodePath.dirname(app), "apps", "app");
    await NodeFsPromises.mkdir(NodePath.dirname(moved), { recursive: true });
    await NodeFsPromises.rename(app, moved);

    const next = await hash(moved, built.workspaces ?? []);
    expect(next.workspaces).toEqual([]);
    expect(next.hash).not.toBe(built.hash);
  });

  it("never counts this package as a workspace", async () => {
    const { app } = await makeMonorepo();
    const own = fileURLToPath(
      new URL(".", import.meta.resolve("@alchemy.run/frontend-frameworks/package.json")),
    );
    const result = await hash(app, [own, NodePath.join(own, "dist")]);
    expect(result.workspaces).toEqual([]);
    expect(result.hash).toBe((await hash(app, [])).hash);
  });

  describe("pinned memo.workspaces", () => {
    const memo: MemoOptions = { workspaces: [{ cwd: "../lib" }] };

    it("hashes the pinned set, ignores detected workspaces and records none", async () => {
      const { app, greeting } = await makeMonorepo();
      const before = await hash(app, ["../does-not-exist", "../other"], memo);
      expect(before.workspaces).toBeUndefined();
      expect((await hash(app, [], memo)).hash).toBe(before.hash);

      await NodeFsPromises.writeFile(greeting, `export const greeting = "hi";`);
      expect((await hash(app, [], memo)).hash).not.toBe(before.hash);
    });

    it("scopes each pinned workspace with its own globs", async () => {
      const { app, lib } = await makeMonorepo();
      const scoped: MemoOptions = { workspaces: [{ cwd: "../lib", include: ["src/**"] }] };
      const before = await hash(app, [], scoped);
      await NodeFsPromises.writeFile(NodePath.join(lib, "README.md"), "outside the scope");
      expect((await hash(app, [], scoped)).hash).toBe(before.hash);
    });

    it("fails when a pinned workspace is missing", async () => {
      const { app, lib } = await makeMonorepo();
      await NodeFsPromises.rm(lib, { recursive: true });
      await expect(hash(app, [], memo)).rejects.toThrow();
    });
  });
});

describe("hashInput tree", () => {
  it("follows a symlinked directory, with and without memo globs", async () => {
    const { app, lib, greeting } = await makeMonorepo();
    await NodeFsPromises.symlink(NodePath.join(lib, "src"), NodePath.join(app, "linked"), "dir");
    for (const memo of [undefined, { include: ["**/*.ts"] }]) {
      const before = await hash(app, [], memo);
      await NodeFsPromises.writeFile(greeting, `export const greeting = "${Math.random()}";`);
      expect((await hash(app, [], memo)).hash).not.toBe(before.hash);
    }
  });

  it("ends a symlink cycle", async () => {
    const { app } = await makeMonorepo();
    await NodeFsPromises.symlink(app, NodePath.join(app, "src", "loop"), "dir");
    await expect(hash(app, [])).resolves.toBeDefined();
  });

  it("never hashes node_modules, .git or output directories, with memo globs", async () => {
    const { app } = await makeMonorepo();
    const memo = { include: ["**/*"] };
    const before = await hash(app, [], memo);
    for (const file of ["node_modules/dep/index.js", ".git/HEAD", "dist/out.js"]) {
      const full = NodePath.join(app, file);
      await NodeFsPromises.mkdir(NodePath.dirname(full), { recursive: true });
      await NodeFsPromises.writeFile(full, "x");
    }
    expect((await hash(app, [], memo)).hash).toBe(before.hash);
  });
});

describe("makeWorkerSource hash", () => {
  it("re-hashes over a deleted recorded workspace without failing (#2606)", async () => {
    const { app, lib } = await makeMonorepo();
    const source = makeWorkerSource({
      provider: "test",
      framework: "test",
      displayName: "Test",
      rootDir: app,
      memo: undefined,
      outputDirs: ["dist"],
      buildConfig: () => ({}),
      dev: () => Effect.die("unused"),
    });
    const ctx = {} as SourceContext;
    const previous: SourceHash = {
      bundle: undefined,
      assets: undefined,
      input: undefined,
      additionalWorkspaces: ["../lib"],
    };
    const recorded = await run(source.hash(ctx, previous) as Effect.Effect<Partial<SourceHash>>);
    expect(recorded.additionalWorkspaces).toEqual(["../lib"]);

    await NodeFsPromises.rm(lib, { recursive: true });
    const next = await run(source.hash(ctx, previous) as Effect.Effect<Partial<SourceHash>>);
    expect(next.additionalWorkspaces).toEqual([]);
    expect(next.input).not.toBe(recorded.input);
  });
});
