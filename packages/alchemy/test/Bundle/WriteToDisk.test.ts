import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Bundle from "@/Bundle/Bundle";

layer(NodeServices.layer)("Bundle output location", (it) => {
  it.effect(
    "build keeps the bundle in memory when no dir or file is set",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "alchemy-bundle-in-memory-" });
        const entry = path.join(root, "entry.ts");
        yield* fs.writeFileString(entry, `console.log("IN_MEMORY_MARKER");\n`);

        const result = yield* Bundle.build({ input: entry, cwd: root });

        expect(result.files[0].content).toContain("IN_MEMORY_MARKER");
        // Rolldown's default `dir` would have been `<root>/dist`.
        expect(yield* fs.readDirectory(root)).toEqual(["entry.ts"]);

        yield* fs.remove(root, { recursive: true });
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "build writes the bundle to the given dir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "alchemy-bundle-dir-" });
        const entry = path.join(root, "entry.ts");
        yield* fs.writeFileString(entry, `console.log("ON_DISK_MARKER");\n`);
        const dir = path.join(root, "out");

        const result = yield* Bundle.build(
          { input: entry, cwd: root },
          { dir, entryFileNames: "index.mjs" },
        );

        expect(result.files[0].path).toBe("index.mjs");
        expect(yield* fs.readFileString(path.join(dir, "index.mjs"))).toContain("ON_DISK_MARKER");

        yield* fs.remove(root, { recursive: true });
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "watch emits the bundle without writing it when no dir or file is set",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "alchemy-bundle-watch-" });
        const entry = path.join(root, "entry.ts");
        yield* fs.writeFileString(entry, `console.log("WATCH_MARKER");\n`);

        const first = yield* Bundle.watch({ input: entry, cwd: root }).pipe(
          Stream.filter((event) => event._tag !== "Start"),
          Stream.runHead,
        );

        const event = Option.getOrThrow(first);
        expect(event._tag).toBe("Success");
        if (event._tag === "Success") {
          expect(event.output.files[0].content).toContain("WATCH_MARKER");
        }
        expect(yield* fs.readDirectory(root)).toEqual(["entry.ts"]);

        yield* fs.remove(root, { recursive: true });
      }),
    { tags: ["unit", "local"] },
  );
});
