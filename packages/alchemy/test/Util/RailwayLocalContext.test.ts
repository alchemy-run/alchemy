import {
  hashRailwayLocalContext,
  prepareRailwayLocalContext,
  resolveRailwayServiceSource,
} from "@/Railway/local-context.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as zlib from "node:zlib";

const describe = layer(NodeServices.layer);

const tarFiles = (gz: Uint8Array) => {
  const tar = zlib.gunzipSync(gz);
  const files = new Map<string, { contents: Uint8Array; mode: number }>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, end: number) =>
      new TextDecoder()
        .decode(header.subarray(start, end))
        .replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 500);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(124, 136), 8) || 0;
    if (String.fromCharCode(header[156]!) !== "5") {
      files.set(path, {
        contents: tar.slice(offset + 512, offset + 512 + size),
        mode: Number.parseInt(text(100, 108), 8),
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

describe("Railway local Docker contexts", (it) => {
  it.effect("requires one unambiguous source mode", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveRailwayServiceSource({
          main: "api.ts",
          image: "node:26",
        }),
      ).toMatchObject({ mode: "main" });
      expect(
        yield* resolveRailwayServiceSource({ context: "." }),
      ).toMatchObject({
        mode: "context",
      });

      const missing = yield* Effect.result(resolveRailwayServiceSource({}));
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing)) {
        expect(missing.failure._tag).toBe("Railway.ServiceImageOrMainRequired");
      }

      const mixed = yield* Effect.result(
        resolveRailwayServiceSource({ context: ".", repo: "acme/api" }),
      );
      expect(Result.isFailure(mixed)).toBe(true);
      if (Result.isFailure(mixed)) {
        expect(mixed.failure._tag).toBe("Railway.ServiceSourceInvalid");
      }
    }),
  );

  it.effect("uses cleaned BOM Dockerfile-specific ignore rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-ignore-",
      });
      yield* fs.writeFileString(
        path.join(context, "Api.Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "kept.txt\n",
      );
      yield* fs.writeFileString(
        path.join(context, "Api.Dockerfile.dockerignore"),
        "\uFEFF./tmp/../ignored*.txt\n!ignored-keep.txt\n",
      );
      yield* fs.writeFileString(path.join(context, "ignored.txt"), "one");
      yield* fs.writeFileString(path.join(context, "ignored-keep.txt"), "one");
      yield* fs.writeFileString(path.join(context, "kept.txt"), "one");

      const source = { context, dockerfilePath: "Api.Dockerfile" };
      const initial = yield* hashRailwayLocalContext(source);
      yield* fs.writeFileString(path.join(context, "ignored.txt"), "two");
      expect(yield* hashRailwayLocalContext(source)).toBe(initial);
      yield* fs.writeFileString(path.join(context, "ignored-keep.txt"), "two");
      expect(yield* hashRailwayLocalContext(source)).not.toBe(initial);

      const prepared = yield* prepareRailwayLocalContext(source);
      const files = yield* Effect.sync(() => tarFiles(prepared.tarball));
      expect(files.has("ignored.txt")).toBe(false);
      expect(files.has("ignored-keep.txt")).toBe(true);
      expect(files.has("kept.txt")).toBe(true);
    }),
  );

  it.effect("includes the selected Dockerfile path in code identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-dockerfile-identity-",
      });
      for (const name of ["Dockerfile", "Api.Dockerfile"]) {
        yield* fs.writeFileString(path.join(context, name), "FROM scratch\n");
      }
      const first = yield* hashRailwayLocalContext({ context });
      const second = yield* hashRailwayLocalContext({
        context,
        dockerfilePath: "Api.Dockerfile",
      });
      expect(second).not.toBe(first);
    }),
  );

  it.effect("archives and hashes one bounded snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-snapshot-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.writeFileString(path.join(context, "app.txt"), "before");
      const start = path.join(context, "start.sh");
      yield* fs.writeFileString(start, "#!/bin/sh\n");
      yield* fs.chmod(start, 0o755);
      const before = yield* hashRailwayLocalContext({ context });
      const prepared = yield* prepareRailwayLocalContext({ context });
      expect(prepared.codeHash).toBe(before);
      yield* fs.writeFileString(path.join(context, "app.txt"), "after");
      const files = yield* Effect.sync(() => tarFiles(prepared.tarball));
      expect(new TextDecoder().decode(files.get("app.txt")?.contents)).toBe(
        "before",
      );
      expect(files.get("start.sh")?.mode).toBe(0o755);
      expect(yield* hashRailwayLocalContext({ context })).not.toBe(
        prepared.codeHash,
      );
    }),
  );

  it.effect("rejects missing, wrong-type, escaping, and non-ASCII paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-paths-",
      });
      const missing = yield* Effect.result(
        hashRailwayLocalContext({ context: path.join(root, "missing") }),
      );
      expect(Result.isFailure(missing) && missing.failure._tag).toBe(
        "Railway.ServiceContextPathInvalid",
      );

      const context = path.join(root, "context");
      yield* fs.makeDirectory(context);
      yield* fs.makeDirectory(path.join(context, "Dockerfile"));
      const wrongType = yield* Effect.result(
        hashRailwayLocalContext({ context }),
      );
      expect(Result.isFailure(wrongType) && wrongType.failure._tag).toBe(
        "Railway.ServiceContextPathInvalid",
      );

      yield* fs.remove(path.join(context, "Dockerfile"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\n",
      );
      const outside = yield* Effect.result(
        hashRailwayLocalContext({ context, dockerfilePath: "../Dockerfile" }),
      );
      expect(Result.isFailure(outside) && outside.failure._tag).toBe(
        "Railway.ServiceDockerfileOutsideContext",
      );

      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.writeFileString(path.join(context, "café.txt"), "nope");
      const unicode = yield* Effect.result(
        prepareRailwayLocalContext({ context }),
      );
      expect(Result.isFailure(unicode) && unicode.failure._tag).toBe(
        "Railway.ServiceContextPathUnsupported",
      );
    }),
  );

  it.effect("rejects final, intermediate, and context symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-symlink-",
      });
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(
        path.join(outside, "Dockerfile"),
        "FROM scratch\n",
      );

      const finalContext = path.join(root, "final");
      yield* fs.makeDirectory(finalContext);
      yield* fs.symlink(
        path.join(outside, "Dockerfile"),
        path.join(finalContext, "Dockerfile"),
      );
      const final = yield* Effect.result(
        hashRailwayLocalContext({ context: finalContext }),
      );
      expect(Result.isFailure(final) && final.failure._tag).toBe(
        "Railway.ServiceContextSymlinkUnsupported",
      );

      const intermediateContext = path.join(root, "intermediate");
      yield* fs.makeDirectory(intermediateContext);
      yield* fs.symlink(outside, path.join(intermediateContext, "linked"));
      const intermediate = yield* Effect.result(
        hashRailwayLocalContext({
          context: intermediateContext,
          dockerfilePath: "linked/Dockerfile",
        }),
      );
      expect(Result.isFailure(intermediate) && intermediate.failure._tag).toBe(
        "Railway.ServiceContextSymlinkUnsupported",
      );

      const linkedContext = path.join(root, "linked-context");
      yield* fs.symlink(outside, linkedContext);
      const linked = yield* Effect.result(
        hashRailwayLocalContext({ context: linkedContext }),
      );
      expect(Result.isFailure(linked) && linked.failure._tag).toBe(
        "Railway.ServiceContextSymlinkUnsupported",
      );

      const containingContext = path.join(root, "containing");
      yield* fs.makeDirectory(containingContext);
      yield* fs.writeFileString(
        path.join(containingContext, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.symlink(outside, path.join(containingContext, "linked"));
      const containing = yield* Effect.result(
        prepareRailwayLocalContext({ context: containingContext }),
      );
      expect(Result.isFailure(containing) && containing.failure._tag).toBe(
        "Railway.ServiceContextSymlinkUnsupported",
      );
    }),
  );

  it.effect("bounds archive bytes and pathological entry counts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-large-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.writeFile(
        path.join(context, "large.bin"),
        new Uint8Array(32 * 1024 * 1024 - 2048),
      );
      const overhead = yield* Effect.result(
        hashRailwayLocalContext({ context }),
      );
      expect(Result.isFailure(overhead) && overhead.failure._tag).toBe(
        "Railway.ServiceContextTooLarge",
      );

      const many = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-railway-many-",
      });
      yield* fs.writeFileString(
        path.join(many, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* Effect.forEach(
        Array.from({ length: 10_000 }, (_, index) => index),
        (index) =>
          fs.writeFile(path.join(many, `empty-${index}`), new Uint8Array()),
        { concurrency: 64, discard: true },
      );
      const entries = yield* Effect.result(
        hashRailwayLocalContext({ context: many }),
      );
      expect(Result.isFailure(entries) && entries.failure._tag).toBe(
        "Railway.ServiceContextTooLarge",
      );
    }),
  );
});
