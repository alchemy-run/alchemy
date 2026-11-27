import { readAssets } from "@alchemy.run/cloudflare/Workers/Assets";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const tags = ["unit", "provider:cloudflare", "local"];

/** A FileSystem whose reads of `slow` files finish after every other read. */
const finishingLast = (fs: FileSystem.FileSystem, slow: ReadonlySet<string>) => ({
  ...fs,
  readFile: (file: string) =>
    slow.has(file)
      ? Effect.gen(function* () {
          for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
          return yield* fs.readFile(file);
        })
      : fs.readFile(file),
});

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

          let active = 0;
          let peak = 0;
          const monitored = {
            ...fs,
            readFile: (file: string) =>
              Effect.suspend(() => {
                active++;
                peak = Math.max(peak, active);
                return Effect.yieldNow.pipe(
                  Effect.andThen(fs.readFile(file)),
                  Effect.ensuring(Effect.sync(() => active--)),
                );
              }),
          };
          const assets = yield* readAssets({
            directory,
            base: "/docs/",
            notFoundHandling: "single-page-application",
          }).pipe(Effect.provideService(FileSystem.FileSystem, monitored));

          // Produced by the serial implementation on main for this fixture.
          expect(assets.hash).toBe(
            "73dc48c021b537ed02d0a4aa270265a4384f8252b1ec78205b64e3117eab092d",
          );
          expect(peak).toBeGreaterThan(1);
          expect(peak).toBeLessThanOrEqual(16);
        }),
      ),
    { tags },
  );

  // Linux keeps both NFC and NFD spellings and treats `\` as a filename
  // character; macOS and Windows can't create this fixture.
  it.effect.skipIf(process.platform !== "linux")(
    "resolves colliding names in listing order, not read completion order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-manifest-key-" });
          const file = (name: string) => path.join(directory, name);
          // Both normalize to `/a/b.txt`.
          yield* fs.makeDirectory(file("a"));
          yield* fs.writeFileString(file("a/b.txt"), "nested");
          yield* fs.writeFileString(file("a\\b.txt"), "backslash");
          // Distinct files whose names localeCompare as equal.
          yield* fs.writeFileString(file("café.html"), "composed");
          yield* fs.writeFileString(file("café.html"), "decomposed");

          const run = (slow: ReadonlyArray<string>) =>
            readAssets({ directory }).pipe(
              Effect.provideService(
                FileSystem.FileSystem,
                finishingLast(fs, new Set(slow.map(file))),
              ),
            );
          const first = yield* run(["a/b.txt", "café.html"]);
          const second = yield* run(["a\\b.txt", "café.html"]);
          expect(Object.keys(second.manifest)).toEqual(Object.keys(first.manifest));
          expect(second.manifest).toEqual(first.manifest);
          expect(second.hash).toBe(first.hash);
        }),
      ),
    { tags },
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
                return Effect.yieldNow.pipe(
                  Effect.andThen(fs.readFile(file)),
                  Effect.ensuring(Effect.sync(() => active--)),
                );
              }),
          };
          yield* readAssets({ directory }).pipe(
            Effect.provideService(FileSystem.FileSystem, monitored),
          );
          // A 64 MiB budget admits three 20 MiB files, not the 16-file pool.
          expect(peak).toBe(3);
        }),
      ),
    { tags },
  );
});
