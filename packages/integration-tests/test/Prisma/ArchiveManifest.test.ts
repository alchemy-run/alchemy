import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  findArchiveManifest,
  inspectVerifiedFile,
} from "../../../prisma/src/internal/ArtifactFile.ts";
import { tarArchive } from "./fixtures/TarArchive.ts";

const manifest = {
  name: "compute.manifest.json",
  data: new TextEncoder().encode('{"manifestVersion":"1","entrypoint":"server.js"}'),
};
const server = { name: "server.js", data: new TextEncoder().encode("export {};\n") };

/** Random bytes, which gzip cannot shrink, so the archive spans many 64 KiB reads. */
const noise = (name: string, bytes: number) => ({ name, data: new Uint8Array(randomBytes(bytes)) });

/** The fastest gzip level: random bytes do not compress, and other tests share this process. */
const gzip = (archive: Uint8Array) => gzipSync(archive, { level: 1 });

const big = noise("assets/blob.bin", 3 * 1024 * 1024);
const middle = noise("assets/middle.bin", 1024 * 1024);

/**
 * Whether this process holds `file` open. Other tests run in the same process,
 * so this looks for the one file rather than counting descriptors.
 */
const isOpen = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(file);
    if (yield* fs.exists("/proc/self/fd")) {
      const fds = yield* fs.readDirectory("/proc/self/fd");
      const targets = yield* Effect.forEach(fds, (fd) =>
        fs.readLink(`/proc/self/fd/${fd}`).pipe(Effect.orElseSucceed(() => "")),
      );
      return targets.includes(real);
    }
    const listing = yield* Effect.sync(() =>
      execFileSync("lsof", ["-a", "-p", String(process.pid), "-Fn"], { encoding: "utf8" }),
    );
    return listing.split("\n").includes(`n${real}`);
  });

const check = (archive: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-archive-manifest-" });
    const file = path.join(root, "app.tar.gz");
    yield* fs.writeFile(file, archive);
    const verified = yield* inspectVerifiedFile(file, 768 * 1024 * 1024);
    const result = yield* findArchiveManifest(verified).pipe(Effect.timeout("5 seconds"));
    // The read is over, so the artifact's file handle is closed.
    expect(yield* isOpen(file)).toBe(false);
    return { result };
  }).pipe(Effect.scoped);

describe(
  "Prisma Compute archive manifest check",
  { tags: ["unit", "provider:prisma", "provider:prisma:computeversion"] },
  () => {
    const cases = [
      { position: "first", entries: [manifest, server, big], expected: "Found" },
      { position: "in the middle", entries: [middle, manifest, server, big], expected: "Found" },
      { position: "last", entries: [server, big, manifest], expected: "Found" },
      { position: "absent", entries: [server, big], expected: "Missing" },
    ] as const;
    for (const { position, entries, expected } of cases) {
      it.live(`returns promptly and closes the file with the manifest ${position}`, () =>
        Effect.gen(function* () {
          const archive = gzip(tarArchive(entries));
          expect(archive.byteLength).toBeGreaterThan(3 * 1024 * 1024);
          const { result } = yield* check(archive);
          expect(result._tag).toBe(expected);
        }).pipe(Effect.provide(PlatformServices)),
      );
    }

    it.live("reports a truncated archive as corrupt and closes the file", () =>
      Effect.gen(function* () {
        const archive = gzip(tarArchive([server, big, manifest]));
        const { result } = yield* check(archive.subarray(0, 2 * 1024 * 1024));
        expect(result._tag).toBe("Corrupt");
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.live("reports gzip data damaged mid-stream as corrupt, promptly, and closes the file", () =>
      Effect.gen(function* () {
        const archive = gzip(tarArchive([server, big, manifest]));
        const damaged = new Uint8Array(archive);
        const middleByte = Math.floor(damaged.length / 2);
        for (let index = middleByte; index < middleByte + 4096; index++) damaged[index] ^= 0xff;
        const { result } = yield* check(damaged);
        expect(result._tag).toBe("Corrupt");
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.live("reports an uncompressed archive as not gzip, promptly, and closes the file", () =>
      Effect.gen(function* () {
        const { result } = yield* check(tarArchive([manifest, server, big]));
        expect(result._tag).toBe("NotGzip");
      }).pipe(Effect.provide(PlatformServices)),
    );

    it.live("reads old-GNU headers, whose name-prefix bytes hold timestamps", () =>
      Effect.gen(function* () {
        const { result } = yield* check(gzip(tarArchive([server, big, manifest], "gnu")));
        expect(result).toEqual({ _tag: "Found", entrypoint: "server.js" });
      }).pipe(Effect.provide(PlatformServices)),
    );

    // Live clock: the test sleeps while the read runs.
    it.live("closes the file when the read is interrupted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-archive-manifest-" });
        const file = path.join(root, "app.tar.gz");
        const huge = noise("assets/huge.bin", 16 * 1024 * 1024);
        yield* fs.writeFile(file, gzip(tarArchive([server, huge])));
        const verified = yield* inspectVerifiedFile(file, 768 * 1024 * 1024);
        const fiber = yield* Effect.forkChild(findArchiveManifest(verified));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.hasInterrupts(exit)).toBe(true);
        // An interrupted read closes the file once its pending read returns.
        yield* Effect.sleep("100 millis");
        expect(yield* isOpen(file)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    );
  },
);
