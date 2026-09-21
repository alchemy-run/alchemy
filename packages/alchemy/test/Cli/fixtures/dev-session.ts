import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import {
  acquireDevSession,
  type DevSessionOptions,
} from "alchemy/Cli/DevSession";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* Effect.sync(
    () =>
      JSON.parse(process.env.SESSION_INPUT!) as {
        options: DevSessionOptions;
        result: string;
        stop: string;
        fail?: boolean;
        cancel?: boolean;
      },
  );
  yield* Effect.gen(function* () {
    const owner = yield* acquireDevSession(input.options);
    if (input.fail && owner.owned)
      return yield* Effect.fail(new Error("setup failed"));
    yield* fs.writeFileString(input.result, JSON.stringify(owner));
    if (input.cancel) return yield* Effect.interrupt;
    if (owner.owned) {
      yield* fs.exists(input.stop).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          until: Boolean,
          times: 1200,
        }),
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      fs.writeFileString(
        input.result,
        JSON.stringify({ error: error.message }),
      ),
    ),
  );
});
program.pipe(Effect.provide(PlatformServices), Effect.scoped, runMain);
