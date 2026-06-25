import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const materializeDockerfile = Effect.fn(function* (
  dockerfile: string,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const target = path.join(dir, "Dockerfile");
  yield* fs.writeFileString(target, dockerfile);
  return target;
});

export const writeContextFiles = Effect.fn(function* (
  dir: string,
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string | Uint8Array;
  }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of files) {
    const fullPath = path.join(dir, file.path);
    yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
    if (typeof file.content === "string") {
      yield* fs.writeFileString(fullPath, file.content);
    } else {
      yield* fs.writeFile(fullPath, file.content);
    }
  }
});
