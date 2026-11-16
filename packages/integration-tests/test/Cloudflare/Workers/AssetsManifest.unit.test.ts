import { readAssets } from "@alchemy.run/cloudflare/Workers/Assets";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Cloudflare Worker asset manifest hashing", (it) => {
  it.effect(
    "hashes files concurrently with a bounded pool and preserves the serial manifest",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-manifest-" });
          yield* fs.makeDirectory(path.join(directory, "assets"));

          yield* fs.writeFileString(path.join(directory, "index.html"), "<h1>Index</h1>");
          yield* fs.symlink(
            path.join(directory, "index.html"),
            path.join(directory, "index-alias.html"),
          );
          yield* fs.writeFileString(path.join(directory, "same.txt"), "same content");
          yield* fs.writeFileString(path.join(directory, "same.js"), "same content");
          yield* fs.writeFileString(path.join(directory, "_headers"), "/*\n  X-Asset: hashed\n");
          yield* fs.writeFileString(path.join(directory, "_redirects"), "/old /new 301\n");
          yield* fs.writeFileString(path.join(directory, ".assetsignore"), "*.skip");
          yield* fs.writeFileString(path.join(directory, "ignored.skip"), "not uploaded");
          for (let i = 0; i < 40; i++) {
            yield* fs.writeFileString(
              path.join(directory, "assets", `asset-${String(i).padStart(2, "0")}.bin`),
              `payload-${i}`,
            );
          }

          const props = {
            directory,
            base: "/docs/",
            notFoundHandling: "single-page-application" as const,
          };
          const reference = yield* readAssets(props);
          expect(reference.manifest["/docs/index.html"]).toEqual(reference.manifest["/index.html"]);
          expect(reference.manifest["/docs/index-alias.html"]).toEqual(
            reference.manifest["/docs/index.html"],
          );
          expect(reference.manifest["/docs/same.txt"]?.hash).not.toEqual(
            reference.manifest["/docs/same.js"]?.hash,
          );
          expect(reference.manifest["/docs/ignored.skip"]).toBeUndefined();
          expect(reference.manifest["/docs/_headers"]).toBeUndefined();
          expect(reference._headers).toBe("/*\n  X-Asset: hashed\n");
          expect(reference.config?.headers).toBe("/*\n  X-Asset: hashed\n");

          let active = 0;
          let peak = 0;
          const monitored = {
            ...fs,
            readFile: (file: string) => {
              const name = path.basename(file);
              if (!name.startsWith("asset-")) return fs.readFile(file);
              const index = Number(name.slice("asset-".length, -".bin".length));
              return Effect.suspend(() => {
                active++;
                peak = Math.max(peak, active);
                // Vary the number of scheduler yields without relying on
                // wall-clock timers (the test runner uses a virtual clock).
                // Read completion order must not affect the manifest.
                return Effect.gen(function* () {
                  for (let step = 0; step < (index % 5) + 1; step++) {
                    yield* Effect.yieldNow;
                  }
                  return yield* fs.readFile(file);
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active--;
                    }),
                  ),
                );
              });
            },
          };
          const concurrent = yield* readAssets(props).pipe(
            Effect.provideService(FileSystem.FileSystem, monitored),
          );
          expect(concurrent).toEqual(reference);
          expect(peak).toBeGreaterThan(1);
          expect(peak).toBeLessThanOrEqual(16);
          expect(active).toBe(0);
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );

  it.effect(
    "rejects an oversized asset with the existing typed validation error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-manifest-size-" });
          yield* fs.writeFile(
            path.join(directory, "oversized.bin"),
            new Uint8Array(25 * 1024 * 1024 + 1),
          );

          const error = yield* Effect.flip(readAssets({ directory }));
          expect(error._tag).toBe("AssetTooLargeError");
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );

  it.effect(
    "propagates a file read failure and interrupts the other in-flight reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-manifest-error-",
          });
          for (let i = 0; i < 24; i++) {
            yield* fs.writeFileString(path.join(directory, `asset-${i}.txt`), `payload-${i}`);
          }

          let reads = 0;
          let inFlight = 0;
          let interrupted = 0;
          const monitored = {
            ...fs,
            readFile: (file: string) =>
              Effect.suspend(() => {
                if (!path.basename(file).startsWith("asset-")) return fs.readFile(file);
                reads++;
                if (reads === 1) {
                  return Effect.gen(function* () {
                    // Give sibling reads a chance to start before this
                    // read fails with the real filesystem's typed error.
                    yield* Effect.yieldNow;
                    yield* Effect.yieldNow;
                    return yield* fs.readFile(path.join(directory, "missing.txt"));
                  });
                }
                inFlight++;
                return Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      interrupted++;
                      inFlight--;
                    }),
                  ),
                );
              }),
          };

          const error = yield* Effect.flip(
            readAssets({ directory }).pipe(Effect.provideService(FileSystem.FileSystem, monitored)),
          );
          // Effect v4 wraps filesystem failures as PlatformError and
          // exposes the normalized failure category on reason._tag.
          expect(error._tag).toBe("PlatformError");
          if (error._tag === "PlatformError") {
            expect(error.reason._tag).toBe("NotFound");
          }
          expect(reads).toBeGreaterThan(1);
          expect(reads).toBeLessThanOrEqual(16);
          expect(interrupted).toBe(reads - 1);
          expect(inFlight).toBe(0);
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );
});
