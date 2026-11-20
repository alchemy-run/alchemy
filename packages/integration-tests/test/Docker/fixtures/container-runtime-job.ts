import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export default Effect.succeed({
  RuntimeContext: {
    exports: Effect.succeed({
      program: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.stat(process.cwd());
        if ("bun" in process.versions) return yield* Effect.die(new Error("Expected Node.js"));
        console.log("job ran under Node");
      }),
    }),
  },
});
