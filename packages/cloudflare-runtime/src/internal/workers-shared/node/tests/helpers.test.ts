// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, it } from "vitest";
import {
  createAssetsIgnoreFunction,
  getContentType,
  InvalidAssetsIgnoreError,
} from "../helpers.ts";

describe("assets", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wrangler-tests"));
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const makeAssetsIgnore = createAssetsIgnoreFunction(tmpDir).pipe(Effect.provide(platform));

  describe(".assetsignore", () => {
    it("should ignore metafiles by default", async ({ expect }) => {
      const { assetsIgnoreFunction, assetsIgnoreFilePresent } =
        await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFilePresent).toBe(false);

      expect(assetsIgnoreFunction(".assetsignore")).toBeTruthy();
      expect(assetsIgnoreFunction("_redirects")).toBeTruthy();
      expect(assetsIgnoreFunction("_headers")).toBeTruthy();

      // don't ignore metafiles in child directories
      expect(assetsIgnoreFunction(join("child", ".assetsignore"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "_redirects"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "_headers"))).toBeFalsy();
    });

    it("should allow users to force opt-in metafiles", async ({ expect }) => {
      await writeFile(join(tmpDir, "./.assetsignore"), "!.assetsignore\n!_redirects\n!_headers");
      const { assetsIgnoreFunction } = await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFunction(".assetsignore")).toBeFalsy();
      expect(assetsIgnoreFunction("_redirects")).toBeFalsy();
      expect(assetsIgnoreFunction("_headers")).toBeFalsy();
    });

    it("should allow users to ignore files", async ({ expect }) => {
      await writeFile(
        join(tmpDir, "./.assetsignore"),
        "logo.png\nchild/**/*.svg\n!child/nope.svg\n/*.js",
      );
      const { assetsIgnoreFunction } = await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFunction("abc")).toBeFalsy();
      expect(assetsIgnoreFunction("logo.png")).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "logo.png"))).toBeTruthy();
      expect(assetsIgnoreFunction("foo.js")).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "foo.js"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "yup.svg"))).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "a", "b", "c", "yup.svg"))).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "nope.svg"))).toBeFalsy();
    });

    it.for(["", "\ufeff"])(
      "reads UTF-8 patterns with an optional BOM (%j)",
      async (bom, { expect }) => {
        await writeFile(
          join(tmpDir, ".assetsignore"),
          `${bom}café.txt\r\nchild/*.txt\r\n!child/keep.txt\r\n`,
        );
        const { assetsIgnoreFunction, assetsIgnoreFilePresent } =
          await Effect.runPromise(makeAssetsIgnore);

        expect(assetsIgnoreFilePresent).toBe(true);
        expect(assetsIgnoreFunction("café.txt")).toBe(true);
        expect(assetsIgnoreFunction("child/ignore.txt")).toBe(true);
        expect(assetsIgnoreFunction("child/keep.txt")).toBe(false);
      },
    );

    it.for([
      ["UTF-16 LE", Buffer.from("\ufeffignored.txt", "utf16le")],
      ["UTF-16 BE", Buffer.from("\ufeffignored.txt", "utf16le").swap16()],
      ["UTF-16 without a BOM", Buffer.from("ignored.txt", "utf16le")],
      ["invalid UTF-8", Buffer.from([0xff])],
      ["null characters", Buffer.from("ignored\0.txt")],
    ] as const)("rejects %s instead of ignoring its patterns", async ([, contents], { expect }) => {
      await writeFile(join(tmpDir, ".assetsignore"), contents);

      const error = await Effect.runPromise(Effect.flip(makeAssetsIgnore));
      expect(error).toBeInstanceOf(InvalidAssetsIgnoreError);
      expect(error.message).toContain("Save the file as UTF-8 and try again.");
    });

    it("preserves an intentionally empty ignore file", async ({ expect }) => {
      await writeFile(join(tmpDir, ".assetsignore"), "");
      const { assetsIgnoreFunction, assetsIgnoreFilePresent } =
        await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFilePresent).toBe(true);
      expect(assetsIgnoreFunction("keep.txt")).toBe(false);
      expect(assetsIgnoreFunction(".assetsignore")).toBe(true);
    });
  });
});

describe("getContentType", () => {
  it("should return 'text/javascript", ({ expect }) => {
    const contentType = getContentType("/_astro/sponsors.CIiPz7eJ.js");
    expect(contentType).toBe("text/javascript; charset=utf-8");
  });
});
