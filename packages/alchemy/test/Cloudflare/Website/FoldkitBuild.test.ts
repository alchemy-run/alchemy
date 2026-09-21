import {
  FOLDKIT_BUILD_MANIFEST,
  foldkitAssetsFromManifest,
  readFoldkitBuildManifest,
  type FoldkitBuildManifest,
} from "@/Cloudflare/Website/FoldkitBuild";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "alchemy-test";
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
});

describe("foldkitAssetsFromManifest", () => {
  it("gives a client-only build the single-page-application fallback", () => {
    expect(foldkitAssetsFromManifest(undefined)).toEqual({
      notFoundHandling: "single-page-application",
    });
  });

  it("derives nothing for a server-rendered build", () => {
    // The build leaves no template in the client output, so every
    // unrendered path already reaches the handler under the defaults.
    expect(foldkitAssetsFromManifest(manifest([]))).toBeUndefined();
  });

  it("derives nothing for a prerendered build", () => {
    expect(
      foldkitAssetsFromManifest(manifest(["/", "/about"])),
    ).toBeUndefined();
  });
});

layer(NodeServices.layer)("readFoldkitBuildManifest", (it) => {
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

  it.effect("resolves to nothing without a server directory", () =>
    Effect.gen(function* () {
      expect(yield* readFoldkitBuildManifest(undefined)).toBeUndefined();
    }),
  );

  it.effect("resolves to nothing when the build wrote no manifest", () =>
    withServerDirectory(undefined, (directory) =>
      Effect.gen(function* () {
        expect(yield* readFoldkitBuildManifest(directory)).toBeUndefined();
      }),
    ),
  );

  it.effect("reads what the Foldkit plugin writes", () =>
    withServerDirectory(
      JSON.stringify(manifest(["/", "/about"])),
      (directory) =>
        Effect.gen(function* () {
          const read = yield* readFoldkitBuildManifest(directory);
          expect(read?.prerendered).toEqual(["/", "/about"]);
          expect(read?.serverEntry).toBe("fetch.js");
        }),
    ),
  );

  it.effect("refuses a manifest shape it does not know", () =>
    withServerDirectory(
      JSON.stringify({ ...manifest([]), schemaVersion: 2 }),
      (directory) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(readFoldkitBuildManifest(directory));
          expect(exit._tag).toBe("Failure");
        }),
    ),
  );

  it.effect("refuses a manifest that is not JSON", () =>
    withServerDirectory("{", (directory) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(readFoldkitBuildManifest(directory));
        expect(exit._tag).toBe("Failure");
      }),
    ),
  );
});
