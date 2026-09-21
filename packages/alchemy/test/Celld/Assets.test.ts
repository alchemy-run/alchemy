import { readAssets } from "@/Celld/Assets";
import { prepareDeployment, type DeploymentError } from "@/Celld/Deployment";
import type { CelldAssetsConfig } from "@/Celld/DeploymentConfig";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, test } from "alchemy-test";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const compatibility = { date: "2026-01-01", flags: ["nodejs_compat"] } as const;

interface Fixture {
  root: string;
  main: string;
  directory: string;
  fs: FileSystem.FileSystem;
  path: Path.Path;
  write: (
    name: string,
    value: string | Uint8Array,
  ) => Effect.Effect<void, import("effect/PlatformError").PlatformError>;
}

const withDirectory = <A, E>(
  run: (
    fixture: Fixture,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temp = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-celld-assets-",
    });
    const root = yield* fs.realPath(temp);
    const main = path.join(root, "worker project", "entry.ts");
    const directory = path.join(path.dirname(main), "public");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(main, "export default {};");
    const write = (name: string, value: string | Uint8Array) =>
      Effect.gen(function* () {
        const target = path.join(directory, name);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* typeof value === "string"
          ? fs.writeFileString(target, value)
          : fs.writeFile(target, value);
      });
    return yield* run({ root, main, directory, fs, path, write });
  }).pipe(Effect.scoped, Effect.provide(platform));

const rejects = (effect: ReturnType<typeof readAssets>, message: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("Celld.DeploymentError");
      expect(result.failure.reason).toBe("configuration");
      expect(result.failure.message).toContain(message);
    }
  });

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type AssetReaderContract = [
  Assert<
    Equal<
      Effect.Services<ReturnType<typeof readAssets>>,
      FileSystem.FileSystem | Path.Path
    >
  >,
  Assert<Equal<Effect.Error<ReturnType<typeof readAssets>>, DeploymentError>>,
];

describe("Celld asset reader", () => {
  test.effect(
    "resolves filesystem paths and file URLs relative to the Worker entry",
    () =>
      withDirectory(({ main, path, write }) =>
        Effect.gen(function* () {
          yield* write("index.html", "hello");
          const fileUrl = yield* path.toFileUrl(main);
          const absolute = yield* readAssets(
            main,
            { directory: "public" },
            compatibility,
          );
          const url = yield* readAssets(
            fileUrl.href,
            { directory: "./public" },
            compatibility,
          );
          const relative = yield* readAssets(
            path.relative(path.resolve("."), main),
            { directory: "public" },
            compatibility,
          );
          expect(url).toEqual(absolute);
          expect(relative).toEqual(absolute);
          expect(absolute.index.entries["/index.html"]).toEqual({
            sha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            bytes: 5,
            content_type: "text/html; charset=utf-8",
          });
          expect(absolute.index.config).toEqual({
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
            run_worker_first: false,
            compatibility_date: "2026-01-01",
            compatibility_flags: ["nodejs_compat"],
          });
          expect(absolute.index.config.compatibility_flags).not.toBe(
            compatibility.flags,
          );
        }),
      ),
  );

  test.effect(
    "recurses with native UTF-8 ordering and deduplicates exact binary bodies",
    () =>
      withDirectory(({ main, write }) =>
        Effect.gen(function* () {
          const binary = yield* Effect.sync(
            () => new Uint8Array([0, 255, 128]),
          );
          yield* write("a/z.bin", binary);
          yield* write("a.txt", "hello");
          yield* write("same.html", "hello");
          yield* write("empty", "");
          yield* write("\u{10000}.txt", "hello");
          yield* write("\ue000.txt", "hello");
          const assets = yield* readAssets(
            main,
            { directory: "public" },
            compatibility,
          );
          expect(Object.keys(assets.index.entries)).toEqual([
            "/a.txt",
            "/a/z.bin",
            "/empty",
            "/same.html",
            "/\ue000.txt",
            "/\u{10000}.txt",
          ]);
          expect(assets.blobs).toHaveLength(3);
          expect(assets.blobs.map((blob) => blob.sha256)).toEqual(
            assets.blobs.map((blob) => blob.sha256).sort(),
          );
          const binaryEntry = assets.index.entries["/a/z.bin"]!;
          expect(binaryEntry.bytes).toBe(3);
          expect(binaryEntry.content_type).toBeUndefined();
          expect(
            Array.from(
              assets.blobs.find((blob) => blob.sha256 === binaryEntry.sha256)!
                .body,
            ),
          ).toEqual([0, 255, 128]);
          expect(assets.index.entries["/empty"]!.sha256).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          );
          expect(assets.index.entries["/same.html"]!.sha256).toBe(
            assets.index.entries["/a.txt"]!.sha256,
          );
          expect(assets.index.entries["/same.html"]!.content_type).toBe(
            "text/html; charset=utf-8",
          );
          expect(assets.index.entries["/a.txt"]!.content_type).toBe(
            "text/plain; charset=utf-8",
          );
          expect(
            yield* readAssets(main, { directory: "public" }, compatibility),
          ).toEqual(assets);
        }),
      ),
  );

  test.effect(
    "moves only top-level directives into config and preserves their text",
    () =>
      withDirectory(({ main, write }) =>
        Effect.gen(function* () {
          const headers = "\ufeff/*\r\n  X-Example: yes\r\n";
          const redirects = "/old /new 301\n";
          yield* write("_headers", headers);
          yield* write("_redirects", redirects);
          yield* write("nested/_headers", "nested headers");
          yield* write("nested/_redirects", "nested redirects");
          const routes = ["/api/*", "!/api/static/*"];
          const assets = yield* readAssets(
            main,
            {
              directory: "public",
              binding: "ASSETS",
              htmlHandling: "none",
              notFoundHandling: "single-page-application",
              runWorkerFirst: routes,
            },
            compatibility,
          );
          expect(Object.keys(assets.index.entries)).toEqual([
            "/nested/_headers",
            "/nested/_redirects",
          ]);
          expect(assets.blobs).toHaveLength(2);
          expect(assets.index.config).toEqual({
            binding: "ASSETS",
            html_handling: "none",
            not_found_handling: "single-page-application",
            run_worker_first: routes,
            headers,
            redirects,
            compatibility_date: compatibility.date,
            compatibility_flags: [...compatibility.flags],
          });
          expect(assets.index.config.run_worker_first).not.toBe(routes);
        }),
      ),
  );

  test.effect(
    "matches the native MIME table without inventing unknown content types",
    () =>
      withDirectory(({ main, write }) =>
        Effect.gen(function* () {
          const types: Record<string, string | undefined> = {
            "page.htm": "text/html; charset=utf-8",
            "style.css": "text/css; charset=utf-8",
            "main.js": "text/javascript; charset=utf-8",
            "main.mjs": "text/javascript; charset=utf-8",
            "main.cjs": "text/javascript; charset=utf-8",
            "data.JSON": "application/json; charset=utf-8",
            "main.map": "application/json; charset=utf-8",
            "plain.txt": "text/plain; charset=utf-8",
            "feed.xml": "application/xml; charset=utf-8",
            "image.svg": "image/svg+xml",
            "site.webmanifest": "application/manifest+json; charset=utf-8",
            "module.wasm": "application/wasm",
            "image.png": "image/png",
            "image.jpg": "image/jpeg",
            "image.jpeg": "image/jpeg",
            "image.gif": "image/gif",
            "image.webp": "image/webp",
            "image.avif": "image/avif",
            "favicon.ico": "image/x-icon",
            "document.pdf": "application/pdf",
            "font.woff": "font/woff",
            "font.woff2": "font/woff2",
            "font.ttf": "font/ttf",
            "font.otf": "font/otf",
            "sound.mp3": "audio/mpeg",
            "sound.wav": "audio/wav",
            "sound.ogg": "audio/ogg",
            "movie.mp4": "video/mp4",
            "movie.webm": "video/webm",
            "archive.zip": "application/zip",
            "archive.gz": "application/gzip",
            "archive.br": "application/octet-stream",
            "unknown.extension": undefined,
            "no-extension": undefined,
            ".json": undefined,
          };
          for (const name of Object.keys(types)) yield* write(name, "same");
          const assets = yield* readAssets(
            main,
            { directory: "public" },
            compatibility,
          );
          for (const [name, contentType] of Object.entries(types))
            expect(assets.index.entries[`/${name}`]!.content_type).toBe(
              contentType,
            );
          expect(assets.blobs).toHaveLength(1);
        }),
      ),
  );

  test.effect(
    "supports empty directories and feeds the native deployment preparer",
    () =>
      withDirectory(({ main, write }) =>
        Effect.gen(function* () {
          const empty = yield* readAssets(
            main,
            { directory: "public", runWorkerFirst: true },
            { date: "2026-01-01", flags: [] },
          );
          expect(empty.index.entries).toEqual({});
          expect(empty.blobs).toEqual([]);
          expect(empty.index.config.run_worker_first).toBe(true);
          yield* write("one.txt", "hello");
          yield* write("two.txt", "hello");
          const assets = yield* readAssets(
            main,
            { directory: "public" },
            compatibility,
          );
          const deployment = yield* prepareDeployment({
            scriptName: "assets-test",
            mainModule: "worker.js",
            modules: [{ name: "worker.js", content: "export default {};" }],
            metadata: { main_module: "worker.js" },
            doClasses: [],
            sqliteClasses: [],
            assets,
          });
          expect(deployment.manifest.assets?.file_count).toBe(2);
          expect(deployment.manifest.assets?.total_bytes).toBe(10);
          expect(deployment.assetObjects).toHaveLength(1);
        }),
      ),
  );

  test.effect(
    "rejects absolute, parent-traversing and invalid entry paths",
    () =>
      withDirectory(({ main, directory }) =>
        Effect.gen(function* () {
          for (const name of [
            "",
            ".",
            "./",
            "../public",
            "public/../public",
            directory,
          ]) {
            yield* rejects(
              readAssets(main, { directory: name }, compatibility),
              "inside the Worker entry module",
            );
          }
          yield* rejects(
            readAssets(
              "https://example.com/entry.ts",
              { directory: "public" },
              compatibility,
            ),
            "file URL or filesystem",
          );
          yield* rejects(
            readAssets("file://[", { directory: "public" }, compatibility),
            "file URL",
          );
          yield* rejects(
            readAssets(main, { directory: "missing" }, compatibility),
            "Cannot read Celld assets",
          );
          yield* rejects(
            readAssets(main, { directory: "entry.ts" }, compatibility),
            "regular directory",
          );
        }),
      ),
  );

  test.effect(
    "rejects root and intermediate directory symlinks, including internal targets",
    () =>
      withDirectory(({ main, root, directory, fs, path }) =>
        Effect.gen(function* () {
          const parent = path.dirname(main);
          const outside = path.join(root, "outside");
          yield* fs.makeDirectory(outside);
          yield* fs.symlink(directory, path.join(parent, "inside-link"));
          yield* fs.symlink(outside, path.join(parent, "outside-link"));
          yield* fs.makeDirectory(path.join(outside, "nested"));
          for (const name of [
            "inside-link",
            "outside-link",
            "outside-link/nested",
          ])
            yield* rejects(
              readAssets(main, { directory: name }, compatibility),
              "symbolic link",
            );
        }),
      ),
  );

  test.effect(
    "rejects internal, escaping, cyclic and dangling asset links",
    () =>
      withDirectory(({ main, root, directory, fs, path, write }) =>
        Effect.gen(function* () {
          yield* write("safe.txt", "safe");
          const outside = path.join(root, "secret.txt");
          yield* fs.writeFileString(outside, "secret");
          const link = path.join(directory, "link");
          for (const target of [
            path.join(directory, "safe.txt"),
            outside,
            directory,
          ]) {
            yield* fs.symlink(target, link);
            yield* rejects(
              readAssets(main, { directory: "public" }, compatibility),
              "symbolic link",
            );
            yield* fs.remove(link);
          }
          yield* fs.symlink(path.join(root, "missing"), link);
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "Cannot read Celld assets",
          );
        }),
      ),
  );

  test.effect("rejects symlinked and non-file directives", () =>
    withDirectory(({ main, directory, fs, path, write }) =>
      Effect.gen(function* () {
        yield* write("safe.txt", "safe");
        const directive = path.join(directory, "_headers");
        yield* fs.symlink(path.join(directory, "safe.txt"), directive);
        yield* rejects(
          readAssets(main, { directory: "public" }, compatibility),
          "symbolic link",
        );
        yield* fs.remove(directive);
        yield* fs.makeDirectory(directive);
        yield* rejects(
          readAssets(main, { directory: "public" }, compatibility),
          "regular file",
        );
      }),
    ),
  );

  test.effect("refuses reserved root files and unsafe URL spellings", () =>
    withDirectory(({ main, directory, fs, path, write }) =>
      Effect.gen(function* () {
        for (const name of [".assetsignore", "_worker.js"]) {
          yield* write(name, "not public");
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            name,
          );
          yield* fs.remove(path.join(directory, name));
        }
        for (const name of [
          "space name",
          "%2e",
          "query?key",
          "fragment#key",
          "colon:key",
          "back\\slash",
          "control\u0001",
        ]) {
          yield* write(name, "unsafe");
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "asset URL path",
          );
          yield* fs.remove(path.join(directory, name));
        }
        yield* write("nested/_worker.js", "nested");
        expect(
          Object.keys(
            (yield* readAssets(main, { directory: "public" }, compatibility))
              .index.entries,
          ),
        ).toEqual(["/nested/_worker.js"]);
      }),
    ),
  );

  test.effect(
    "enforces UTF-8 URL lengths and directive validity and size",
    () =>
      withDirectory(({ main, directory, fs, path, write }) =>
        Effect.gen(function* () {
          // Synthetic entries can exceed macOS PATH_MAX without failing fixture setup.
          const info = yield* fs.stat(directory);
          const prefix = `${directory}${path.sep}`;
          const filesystem: FileSystem.FileSystem = {
            ...fs,
            realPath: (file) =>
              file.startsWith(prefix)
                ? Effect.succeed(file)
                : fs.realPath(file),
            stat: (file) =>
              file.startsWith(prefix) ? Effect.succeed(info) : fs.stat(file),
            readDirectory: (file) =>
              file === directory || file.startsWith(prefix)
                ? Effect.succeed(["\u00e9".repeat(90)])
                : fs.readDirectory(file),
          };
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "oversized asset URL path",
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, filesystem),
                Layer.succeed(Path.Path, path),
              ),
            ),
          );
          const invalid = yield* Effect.sync(() => new Uint8Array([255]));
          yield* write("_headers", invalid);
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "not UTF-8",
          );
          yield* fs.truncate(path.join(directory, "_headers"), 100 * 1024 + 1);
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "102400-byte limit",
          );
        }),
      ),
  );

  test.effect("rejects special files before attempting a read", () =>
    withDirectory(({ main, fs, path, write }) =>
      Effect.gen(function* () {
        yield* write("pipe", "");
        let read = false;
        const filesystem: FileSystem.FileSystem = {
          ...fs,
          stat: (file) =>
            fs
              .stat(file)
              .pipe(
                Effect.map((info) =>
                  info.type === "File"
                    ? { ...info, type: "FIFO" as const }
                    : info,
                ),
              ),
          readFile: (file) =>
            Effect.sync(() => {
              read = true;
            }).pipe(Effect.andThen(fs.readFile(file))),
        };
        yield* rejects(
          readAssets(main, { directory: "public" }, compatibility),
          "special file",
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, filesystem),
              Layer.succeed(Path.Path, path),
            ),
          ),
        );
        expect(read).toBe(false);
      }),
    ),
  );

  test.effect("rejects files above 25 MiB without reading the body", () =>
    withDirectory(({ main, directory, fs, path, write }) =>
      Effect.gen(function* () {
        yield* write("oversized", "");
        yield* fs.truncate(
          path.join(directory, "oversized"),
          25 * 1024 * 1024 + 1,
        );
        yield* rejects(
          readAssets(main, { directory: "public" }, compatibility),
          "25 MiB file limit",
        );
      }),
    ),
  );

  test.effect(
    "accounts for every path before reading an oversized deployment",
    () =>
      withDirectory(({ main, fs, path, write }) =>
        Effect.gen(function* () {
          for (let i = 0; i < 41; i++) yield* write(`${i}.bin`, "");
          let read = false;
          const filesystem: FileSystem.FileSystem = {
            ...fs,
            stat: (file) =>
              fs
                .stat(file)
                .pipe(
                  Effect.map((info) =>
                    info.type === "File"
                      ? { ...info, size: ByteSize.bytes(25 * 1024 * 1024) }
                      : info,
                  ),
                ),
            readFile: (file) =>
              Effect.sync(() => {
                read = true;
              }).pipe(Effect.andThen(fs.readFile(file))),
          };
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "1 GiB deployment limit",
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, filesystem),
                Layer.succeed(Path.Path, path),
              ),
            ),
          );
          expect(read).toBe(false);
        }),
      ),
  );

  test.effect("rejects more than 20,000 files before reading any blobs", () =>
    withDirectory(({ main, directory, fs, path, write }) =>
      Effect.gen(function* () {
        yield* write("template", "");
        const info = yield* fs.stat(path.join(directory, "template"));
        let read = false;
        const prefix = `${directory}${path.sep}`;
        const filesystem: FileSystem.FileSystem = {
          ...fs,
          realPath: (file) =>
            file.startsWith(prefix) ? Effect.succeed(file) : fs.realPath(file),
          stat: (file) =>
            file.startsWith(prefix) ? Effect.succeed(info) : fs.stat(file),
          readDirectory: (file) =>
            file === directory
              ? Effect.sync(() =>
                  Array.from({ length: 20_001 }, (_, index) => `${index}.txt`),
                )
              : fs.readDirectory(file),
          readFile: (file) =>
            Effect.sync(() => {
              read = true;
            }).pipe(Effect.andThen(fs.readFile(file))),
        };
        yield* rejects(
          readAssets(main, { directory: "public" }, compatibility),
          "20,000-file limit",
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, filesystem),
              Layer.succeed(Path.Path, path),
            ),
          ),
        );
        expect(read).toBe(false);
      }),
    ),
  );

  test.effect(
    "refuses size changes and symlink swaps observed during reads",
    () =>
      withDirectory(({ main, root, directory, fs, path, write }) =>
        Effect.gen(function* () {
          yield* write("asset.txt", "hello");
          const target = path.join(directory, "asset.txt");
          const growing: FileSystem.FileSystem = {
            ...fs,
            readFile: (file) =>
              fs
                .readFile(file)
                .pipe(
                  Effect.flatMap((body) =>
                    Effect.sync(() => new Uint8Array([...body, 0])),
                  ),
                ),
          };
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "changed while being read",
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, growing),
                Layer.succeed(Path.Path, path),
              ),
            ),
          );
          const secret = path.join(root, "secret.txt");
          yield* fs.writeFileString(secret, "other");
          const swapping: FileSystem.FileSystem = {
            ...fs,
            readFile: (file) =>
              Effect.gen(function* () {
                yield* fs.remove(target);
                yield* fs.symlink(secret, target);
                return yield* fs.readFile(file);
              }),
          };
          yield* rejects(
            readAssets(main, { directory: "public" }, compatibility),
            "symbolic link",
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, swapping),
                Layer.succeed(Path.Path, path),
              ),
            ),
          );
        }),
      ),
  );

  test.effect(
    "validates routing modes, binding names and worker-first rules",
    () =>
      withDirectory(({ main }) =>
        Effect.gen(function* () {
          for (const binding of ["", "bad-name", "1binding", "x".repeat(129)])
            yield* rejects(
              readAssets(main, { directory: "public", binding }, compatibility),
              "binding name",
            );
          for (const routes of [
            [],
            ["!/only-negative"],
            ["/same", "/same"],
            ["/"],
            ["not-absolute"],
            ["/back\\slash"],
            [`/${"x".repeat(100)}`],
            Array.from({ length: 101 }, (_, index) => `/route-${index}`),
          ]) {
            yield* rejects(
              readAssets(
                main,
                { directory: "public", runWorkerFirst: routes },
                compatibility,
              ),
              "worker-first",
            );
          }
          yield* rejects(
            readAssets(
              main,
              {
                directory: "public",
                htmlHandling: "invalid" as CelldAssetsConfig["htmlHandling"],
              },
              compatibility,
            ),
            "htmlHandling",
          );
          yield* rejects(
            readAssets(
              main,
              {
                directory: "public",
                notFoundHandling:
                  "invalid" as CelldAssetsConfig["notFoundHandling"],
              },
              compatibility,
            ),
            "notFoundHandling",
          );
        }),
      ),
  );
});
