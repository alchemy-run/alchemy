import {
  createComputeArchive,
  normalizeEntrypoint,
} from "@/Prisma/ComputeArchive";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { gunzipSync } from "node:zlib";

interface TarEntry {
  name: string;
  body: string;
  mode: number;
  type: string;
  linkname: string;
}

const readString = (buffer: Uint8Array, start: number, length: number) => {
  const bytes = buffer.slice(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
};

const parseTar = (buffer: Uint8Array) => {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeText = readString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const bodyStart = offset + 512;
    const body = buffer.slice(bodyStart, bodyStart + size);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      body: new TextDecoder().decode(body),
      mode: Number.parseInt(readString(header, 100, 8).trim() || "0", 8),
      type: readString(header, 156, 1) || "0",
      linkname: readString(header, 157, 100),
    });
    offset = bodyStart + size + ((512 - (size % 512)) % 512);
  }
  return entries;
};

describe("createComputeArchive", () => {
  it.effect("creates the tar.gz format expected by Prisma Compute", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "src", "main.ts"),
        "console.log('hello');",
      );
      yield* fs.writeFileString(path.join(root, "package.json"), "{}");

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "src/main.ts",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry.body]));

      expect(byName.get("bundle/src/main.ts")).toBe("console.log('hello');");
      expect(byName.get("bundle/package.json")).toBe("{}");
      expect(JSON.parse(byName.get("compute.manifest.json")!)).toEqual({
        manifestVersion: "1",
        entrypoint: "bundle/src/main.ts",
      });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects unsafe entrypoints", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.exit(normalizeEntrypoint("../server.ts"));
      const absolute = yield* Effect.exit(normalizeEntrypoint("/server.ts"));

      expect(parent._tag).toBe("Failure");
      expect(absolute._tag).toBe("Failure");
    }),
  );

  it.effect("preserves executable file modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const server = path.join(root, "server.sh");
      yield* fs.writeFileString(server, "#!/bin/sh\n");
      yield* fs.chmod(server, 0o755);

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.sh",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      expect(byName.get("bundle/server.sh")?.mode).toBe(0o755);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects missing entrypoints before uploading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("preserves symlinks that stay inside the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(root, "real.ts"), "real file");
      yield* fs.symlink(path.join(root, "real.ts"), path.join(root, "link.ts"));

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      expect(byName.get("bundle/link.ts")).toMatchObject({
        type: "2",
        linkname: "real.ts",
      });
      expect(byName.get("bundle/real.ts")?.body).toBe("real file");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "preserves symlinked directories that stay inside the artifact root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-",
        });
        const realDir = path.join(root, "real");
        yield* fs.makeDirectory(realDir);
        yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
        yield* fs.writeFileString(path.join(realDir, "nested.ts"), "nested");
        yield* fs.symlink(realDir, path.join(root, "linked"));

        const archive = yield* createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        });
        const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
        const byName = new Map(entries.map((entry) => [entry.name, entry]));

        expect(byName.get("bundle/linked")).toMatchObject({
          type: "2",
          linkname: "real",
        });
        expect(byName.get("bundle/real/nested.ts")?.body).toBe("nested");
        expect(byName.has("bundle/linked/nested.ts")).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects symlinks that escape the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const outside = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-outside-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.symlink(
        path.join(outside, "secret.ts"),
        path.join(root, "secret.ts"),
      );

      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects symlinked directories that escape the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const outside = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-outside-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.symlink(outside, path.join(root, "outside"));

      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );
});
