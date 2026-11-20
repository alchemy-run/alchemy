import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export class ConvexCliNotFound extends Data.TaggedError("ConvexCliNotFound")<{
  readonly message: string;
  readonly rootDir: string;
}> {}

/** Find the project's own `convex` binary, walking up from `rootDir`. */
export const findConvexCli = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(rootDir);
  while (true) {
    const candidate = path.join(current, "node_modules/.bin/convex");
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) {
      return yield* new ConvexCliNotFound({
        rootDir,
        message: `No convex CLI found from ${rootDir}. Add convex to that project's dependencies and install them.`,
      });
    }
    current = parent;
  }
});
