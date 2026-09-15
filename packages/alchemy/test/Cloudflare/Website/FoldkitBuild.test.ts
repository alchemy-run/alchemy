import {
  FOLDKIT_BUILD_MANIFEST,
  foldkitAssetsFromManifest,
  readFoldkitBuildManifest,
  type FoldkitBuildManifest,
} from "@/Cloudflare/Website/FoldkitBuild";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const manifest = (
  prerendered: ReadonlyArray<string>,
): FoldkitBuildManifest => ({
  schemaVersion: 1,
  client: "dist/client",
  server: "dist/server",
  serverEntry: "fetch.js",
  prerendered,
  host: "fetch",
});

describe("foldkitAssetsFromManifest", () => {
  it("gives a client-only build the single-page-application fallback", () => {
    expect(foldkitAssetsFromManifest(undefined, undefined)).toEqual({
      notFoundHandling: "single-page-application",
    });
  });

  it("leaves the unrendered template out of a server-rendered upload", () => {
    expect(foldkitAssetsFromManifest(manifest([]), undefined)).toEqual({
      ignore: ["/index.html"],
    });
  });

  it("keeps a prerendered front page", () => {
    expect(
      foldkitAssetsFromManifest(manifest(["/", "/about"]), undefined),
    ).toBeUndefined();
  });

  it("drops only the root template in a hybrid build", () => {
    // `/about/index.html` is a page; only the root shell is unfilled.
    expect(foldkitAssetsFromManifest(manifest(["/about"]), undefined)).toEqual({
      ignore: ["/index.html"],
    });
  });

  it("defers to a declared single-page-application fallback", () => {
    expect(
      foldkitAssetsFromManifest(manifest([]), {
        notFoundHandling: "single-page-application",
      }),
    ).toBeUndefined();
  });
});

describe("readFoldkitBuildManifest", () => {
  const withServerDirectory = <A, E, R>(
    contents: string | undefined,
    use: (directory: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-foldkit-manifest-",
      });
      if (contents !== undefined) {
        yield* fs.writeFileString(
          path.join(directory, FOLDKIT_BUILD_MANIFEST),
          contents,
        );
      }
      return yield* use(directory);
    }).pipe(Effect.scoped);

  it("resolves to nothing without a server directory", () =>
    Effect.gen(function* () {
      expect(yield* readFoldkitBuildManifest(undefined)).toBeUndefined();
    }));

  it("resolves to nothing when the build wrote no manifest", () =>
    withServerDirectory(undefined, (directory) =>
      Effect.gen(function* () {
        expect(yield* readFoldkitBuildManifest(directory)).toBeUndefined();
      }),
    ));

  it("reads what the Foldkit plugin writes", () =>
    withServerDirectory(
      JSON.stringify(manifest(["/", "/about"])),
      (directory) =>
        Effect.gen(function* () {
          const read = yield* readFoldkitBuildManifest(directory);
          expect(read?.prerendered).toEqual(["/", "/about"]);
          expect(read?.serverEntry).toBe("fetch.js");
        }),
    ));

  it("refuses a manifest shape it does not know", () =>
    withServerDirectory(
      JSON.stringify({ ...manifest([]), schemaVersion: 2 }),
      (directory) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(readFoldkitBuildManifest(directory));
          expect(exit._tag).toBe("Failure");
        }),
    ));
});
