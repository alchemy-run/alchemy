import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";

export default Alchemy.Stack(
  "DevSessionCli",
  {
    providers: Command.providers(),
    state: Alchemy.localState(),
    secrets: [],
  },
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const entry = yield* path
      .fromFileUrl(new URL("./dev-session-server.ts", import.meta.url))
      .pipe(Effect.orDie);
    const directory = yield* Effect.sync(() => process.env.DEV_SESSION_DIR!);
    const profile = yield* Config.String("ALCHEMY_PROFILE").pipe(
      Config.withDefault("unset"),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(path.join(directory, "profile"), profile)
      .pipe(Effect.orDie);
    const command = yield* Command.Dev("Server", {
      command: `bun run ${entry}`,
      env: { DEV_SESSION_DIR: directory },
    });
    return { url: command.url };
  }),
);
