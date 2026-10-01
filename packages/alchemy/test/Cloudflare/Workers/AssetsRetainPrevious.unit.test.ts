/**
 * `assets.retainPrevious`: the manifest arithmetic that keeps the previous
 * build's content-hashed files served after a deploy.
 */
import {
  mergeRetainedAssets,
  previousBuildAssets,
  readAssets,
  requestedCarriedAssets,
  selectRetainedAssets,
  type AssetManifest,
} from "@/Cloudflare/Workers/Assets.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const entry = (hash: string, size = 1) => ({ hash, size });

describe("selectRetainedAssets", () => {
  const manifest: AssetManifest = {
    "/assets/entry-new.js": entry("a"),
    "/assets/nested/chunk-new.js": entry("b"),
    "/favicon.ico": entry("c"),
    "/index.html": entry("d"),
  };

  it("keeps only entries matching the globs", () => {
    expect(selectRetainedAssets(manifest, { paths: ["assets/**"] })).toEqual({
      "/assets/entry-new.js": entry("a"),
      "/assets/nested/chunk-new.js": entry("b"),
    });
  });

  it("matches relative to the base prefix", () => {
    const prefixed: AssetManifest = {
      "/docs/assets/entry-new.js": entry("a"),
      "/docs/index.html": entry("d"),
      // SPA alias outside the prefix
      "/index.html": entry("d"),
    };
    expect(
      selectRetainedAssets(prefixed, { paths: ["assets/**"] }, "/docs"),
    ).toEqual({ "/docs/assets/entry-new.js": entry("a") });
  });
});

describe("mergeRetainedAssets", () => {
  const current: AssetManifest = {
    "/assets/entry-new.js": entry("new"),
    "/assets/shared.js": entry("shared-new"),
    "/index.html": entry("html"),
  };

  it("returns the manifest unchanged without retained entries", () => {
    expect(mergeRetainedAssets(current, undefined)).toEqual({
      manifest: current,
      carried: [],
    });
  });

  it("adds the previous build's paths the current build lacks", () => {
    const retained: AssetManifest = {
      "/assets/entry-old.js": entry("old"),
      "/assets/shared.js": entry("shared-old"),
    };
    const { manifest, carried } = mergeRetainedAssets(current, retained);
    expect(carried).toEqual(["/assets/entry-old.js"]);
    expect(manifest).toEqual({
      "/assets/entry-new.js": entry("new"),
      "/assets/entry-old.js": entry("old"),
      // the current build wins on a shared path
      "/assets/shared.js": entry("shared-new"),
      "/index.html": entry("html"),
    });
    expect(Object.keys(manifest)).toEqual(Object.keys(manifest).sort());
  });

  it("carries one generation", () => {
    // deploy 1 records build 1; deploy 2 carries it and records build 2
    const build1: AssetManifest = { "/assets/one.js": entry("1") };
    const build2: AssetManifest = { "/assets/two.js": entry("2") };
    const build3: AssetManifest = { "/assets/three.js": entry("3") };
    const retain = { paths: ["assets/**"] };

    const deploy2 = mergeRetainedAssets(
      build2,
      selectRetainedAssets(build1, retain),
    );
    expect(deploy2.carried).toEqual(["/assets/one.js"]);
    // what deploy 2 records is its own build, not the merged manifest
    const deploy3 = mergeRetainedAssets(
      build3,
      selectRetainedAssets(build2, retain),
    );
    expect(deploy3.manifest).toEqual({
      "/assets/three.js": entry("3"),
      "/assets/two.js": entry("2"),
    });
  });
});

describe("previousBuildAssets", () => {
  const build1: AssetManifest = { "/assets/one.js": entry("1") };
  const build2: AssetManifest = { "/assets/two.js": entry("2") };
  const build3: AssetManifest = { "/assets/three.js": entry("3") };

  it("carries nothing without a recorded build", () => {
    expect(previousBuildAssets(build1, undefined)).toBeUndefined();
    expect(previousBuildAssets(build1, {})).toBeUndefined();
  });

  it("carries the recorded build when the build changed", () => {
    expect(
      previousBuildAssets(build2, {
        retainedAssets: build1,
        carriedAssets: undefined,
      }),
    ).toEqual(build1);
  });

  it("keeps the previous build across redeploys of the same build", () => {
    // deploy 2 recorded build 2 and carried build 1; deploying build 2
    // again (a Worker-only change) must not drop build 1
    const afterDeploy2 = { retainedAssets: build2, carriedAssets: build1 };
    expect(previousBuildAssets({ ...build2 }, afterDeploy2)).toEqual(build1);
    // deploy 3 moves on to build 2 and drops build 1
    expect(previousBuildAssets(build3, afterDeploy2)).toEqual(build2);
  });

  it("identifies a build by its paths and content hashes", () => {
    const rebuilt: AssetManifest = { "/assets/two.js": entry("2-changed") };
    const recorded = { retainedAssets: build2, carriedAssets: build1 };
    expect(previousBuildAssets(rebuilt, recorded)).toEqual(build2);
    expect(
      previousBuildAssets(
        { ...build2, "/assets/extra.js": entry("x") },
        recorded,
      ),
    ).toEqual(build2);
    expect(previousBuildAssets({}, recorded)).toEqual(build2);
  });
});

describe("requestedCarriedAssets", () => {
  const manifest: AssetManifest = {
    "/assets/current.js": entry("current"),
    "/assets/carried-kept.js": entry("kept"),
    "/assets/carried-evicted.js": entry("evicted"),
    "/assets/carried-same-bytes.js": entry("current"),
  };
  const carried = [
    "/assets/carried-evicted.js",
    "/assets/carried-kept.js",
    "/assets/carried-same-bytes.js",
  ];

  it("returns carried paths the session asks for and no file provides", () => {
    expect(
      requestedCarriedAssets(
        manifest,
        carried,
        new Set(["evicted", "current"]),
        new Set(["current"]),
      ),
    ).toEqual(["/assets/carried-evicted.js"]);
  });

  it("returns nothing when the session asks for no carried hash", () => {
    expect(
      requestedCarriedAssets(
        manifest,
        carried,
        new Set(),
        new Set(["current"]),
      ),
    ).toEqual([]);
  });
});

layer(NodeServices.layer)("readAssets with retainPrevious", (it) => {
  it.effect("keeps the option out of the config and the hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-assets-retain-",
      });
      yield* fs.makeDirectory(path.join(directory, "assets"));
      yield* fs.writeFileString(path.join(directory, "index.html"), "<html>");
      yield* fs.writeFileString(
        path.join(directory, "assets", "entry-abc.js"),
        "export {}",
      );

      const plain = yield* readAssets({ directory, htmlHandling: "none" });
      const retaining = yield* readAssets({
        directory,
        htmlHandling: "none",
        retainPrevious: { paths: ["assets/**"] },
      });

      expect(retaining.config).toEqual({ htmlHandling: "none" });
      expect(retaining.hash).toBe(plain.hash);
      expect(
        selectRetainedAssets(retaining.manifest, { paths: ["assets/**"] }),
      ).toEqual({
        "/assets/entry-abc.js": retaining.manifest["/assets/entry-abc.js"],
      });
    }).pipe(Effect.scoped),
  );
});
