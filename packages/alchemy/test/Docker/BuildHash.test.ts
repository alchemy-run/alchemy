import { hashDockerBuildInputs } from "@/Docker/BuildHash.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const DOCKERFILE = 'FROM alpine:3.19\nCOPY . /app\nCMD ["true"]\n';

const makeContext = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-build-hash-",
  });
  const context = path.join(root, "context");
  yield* fs.makeDirectory(context);
  yield* fs.writeFileString(path.join(context, "Dockerfile"), DOCKERFILE);
  return { root, context };
});

const hashContext = (context: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* hashDockerBuildInputs(
      {
        context,
        dockerfile: path.join(context, "Dockerfile"),
        platform: "linux/amd64",
      },
      "effective",
    );
  });

describe("hashDockerBuildInputs", { tags: ["unit", "local"] }, () => {
  it.effect("hashes a context containing a symlink loop", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { context } = yield* makeContext;
      yield* fs.makeDirectory(path.join(context, "src"));
      yield* fs.writeFileString(path.join(context, "src", "index.ts"), "1");
      yield* fs.symlink("..", path.join(context, "src", "parent"));

      const hash = yield* hashContext(context);

      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );

  it.effect(
    "hashes a directory symlink as a link, not the contents of its target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, context } = yield* makeContext;
        const outside = path.join(root, "outside");
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(path.join(outside, "dep.js"), "first");
        yield* fs.symlink(outside, path.join(context, "node_modules"));

        const before = yield* hashContext(context);
        yield* fs.writeFileString(path.join(outside, "dep.js"), "second");
        const after = yield* hashContext(context);

        expect(after).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );

  it.effect("does not descend into directories ignored by .dockerignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { context } = yield* makeContext;
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "node_modules\n",
      );
      yield* fs.makeDirectory(path.join(context, "node_modules"));
      yield* fs.symlink(
        "..",
        path.join(context, "node_modules", "workspace-root"),
      );
      yield* fs.writeFileString(path.join(context, "app.ts"), "1");

      const before = yield* hashContext(context);
      yield* fs.writeFileString(
        path.join(context, "node_modules", "ignored.js"),
        "changed",
      );
      const ignoredChange = yield* hashContext(context);
      yield* fs.writeFileString(path.join(context, "app.ts"), "2");
      const includedChange = yield* hashContext(context);

      expect(ignoredChange).toBe(before);
      expect(includedChange).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );

  it.effect("keeps files re-included by a negated .dockerignore rule", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { context } = yield* makeContext;
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "docs\n!docs/keep.md\n",
      );
      yield* fs.makeDirectory(path.join(context, "docs"));
      yield* fs.writeFileString(path.join(context, "docs", "keep.md"), "1");
      yield* fs.writeFileString(path.join(context, "docs", "drop.md"), "1");

      const before = yield* hashContext(context);
      yield* fs.writeFileString(path.join(context, "docs", "drop.md"), "2");
      const ignoredChange = yield* hashContext(context);
      yield* fs.writeFileString(path.join(context, "docs", "keep.md"), "2");
      const includedChange = yield* hashContext(context);

      expect(ignoredChange).toBe(before);
      expect(includedChange).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  );
});
