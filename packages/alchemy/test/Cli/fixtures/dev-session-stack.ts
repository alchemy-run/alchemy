import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";

export default Alchemy.Stack(
  "DevSessionCli",
  {
    providers: Command.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const entry = yield* path
      .fromFileUrl(
        new URL("../../Command/fixture/lifecycle.ts", import.meta.url),
      )
      .pipe(Effect.orDie);
    const directory = yield* Effect.sync(() => process.env.LIFECYCLE_DIR!);
    const command = yield* Command.Dev("Server", {
      command: `bun run ${entry}`,
      env: { LIFECYCLE_DIR: directory, LIFECYCLE_MODE: "cooperative" },
    });
    return { url: command.url };
  }),
);
