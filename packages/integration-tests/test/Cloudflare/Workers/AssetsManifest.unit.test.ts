import { readAssets } from "@alchemy.run/cloudflare/Workers/Assets";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Cloudflare Worker asset manifest hashing", (it) => {
  it.effect(
    "hashes files concurrently with a bounded pool and keeps the serial digest",
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
          // Produced by the serial implementation on main for this fixture.
          expect(reference.hash).toBe(
            "73dc48c021b537ed02d0a4aa270265a4384f8252b1ec78205b64e3117eab092d",
          );
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
  it.effect.skipIf(process.platform === "darwin")(
    "orders names that collate equal independently of read completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-manifest-nfc-" });
          // Linux filesystems keep both spellings as distinct files.
          const composed = "caf\u00e9.html";
          const decomposed = "cafe\u0301.html";
          yield* fs.writeFileString(path.join(directory, composed), "composed");
          yield* fs.writeFileString(path.join(directory, decomposed), "decomposed");

          const finishingLast = (slow: string) => ({
            ...fs,
            readFile: (file: string) =>
              path.basename(file) === slow
                ? Effect.gen(function* () {
                    for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
                    return yield* fs.readFile(file);
                  })
                : fs.readFile(file),
          });
          const composedLast = yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, finishingLast(composed)),
          );
          const decomposedLast = yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, finishingLast(decomposed)),
          );
          expect(Object.keys(composedLast.manifest)).toEqual([`/${decomposed}`, `/${composed}`]);
          expect(Object.keys(decomposedLast.manifest)).toEqual(Object.keys(composedLast.manifest));
          expect(decomposedLast.hash).toBe(composedLast.hash);
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );

  it.effect.skipIf(process.platform === "win32")(
    "resolves names that normalize to one key independently of read completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-manifest-key-" });
          // `a\\b.txt` is one file name on POSIX; both become `/a/b.txt`.
          yield* fs.makeDirectory(path.join(directory, "a"));
          yield* fs.writeFileString(path.join(directory, "a", "b.txt"), "nested");
          yield* fs.writeFileString(path.join(directory, "a\\b.txt"), "backslash");

          const finishingLast = (slow: string) => ({
            ...fs,
            readFile: (file: string) =>
              file === path.join(directory, slow)
                ? Effect.gen(function* () {
                    for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
                    return yield* fs.readFile(file);
                  })
                : fs.readFile(file),
          });
          const nestedLast = yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, finishingLast(path.join("a", "b.txt"))),
          );
          const backslashLast = yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, finishingLast("a\\b.txt")),
          );
          expect(Object.keys(nestedLast.manifest)).toEqual(["/a/b.txt"]);
          expect(backslashLast.manifest).toEqual(nestedLast.manifest);
          expect(backslashLast.hash).toBe(nestedLast.hash);
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );

  it.effect(
    "bounds the bytes of large assets read at once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-manifest-bytes-",
          });
          for (let i = 0; i < 6; i++) {
            yield* fs.writeFile(
              path.join(directory, `large-${i}.bin`),
              new Uint8Array(20 * 1024 * 1024).fill(i),
            );
          }

          let active = 0;
          let peak = 0;
          const monitored = {
            ...fs,
            readFile: (file: string) =>
              Effect.suspend(() => {
                active++;
                peak = Math.max(peak, active);
                return Effect.gen(function* () {
                  yield* Effect.yieldNow;
                  return yield* fs.readFile(file);
                }).pipe(Effect.ensuring(Effect.sync(() => active--)));
              }),
          };
          const assets = yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, monitored),
          );
          expect(Object.keys(assets.manifest)).toHaveLength(6);
          // A 64 MiB budget admits three 20 MiB files, not the 16-file pool.
          expect(peak).toBe(3);
        }),
      ),
    { tags: ["unit", "provider:cloudflare", "local"] },
  );
});
