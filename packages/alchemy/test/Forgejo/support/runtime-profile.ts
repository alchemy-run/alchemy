import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { rootDir } from "alchemy/Auth/Paths";

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* Effect.sync(() => process.cwd());
  const directory = path.join(cwd, ".alchemy/forgejo");
  const home = path.join(directory, "runtime-home");
  const source = yield* Effect.sync(rootDir);
  const config = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        baseUrl: Schema.String,
        token: Schema.String,
        username: Schema.String,
      }),
    ),
  )(yield* fs.readFileString(path.join(directory, "fixture.json")));
  const log = yield* fs.readFileString(
    path.join(directory, "runtime-tunnel.log"),
  );
  const url = log.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/)?.[0];
  if (!url)
    return yield* Effect.fail(new Error("Owned Forgejo tunnel has no URL"));
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.chmod(home, 0o700);
  for (const name of ["profiles/testing", "credentials/testing"]) {
    if (yield* fs.exists(path.join(source, name))) {
      yield* fs.makeDirectory(path.dirname(path.join(home, name)), {
        recursive: true,
      });
      yield* fs.copy(path.join(source, name), path.join(home, name), {
        overwrite: true,
      });
    }
  }
  const profile = path.join(home, "profiles/testing/forgejo.json");
  yield* fs.writeFileString(
    profile,
    JSON.stringify({
      format: "alchemy.profile/v1",
      provider: "Forgejo",
      metadata: {},
      values: { method: "stored", baseUrl: url, token: config.token },
    }),
  );
  yield* fs.chmod(profile, 0o600);
  yield* Effect.logInfo(
    "Prepared isolated testing profile for Forgejo runtime acceptance; user profiles unchanged.",
  );
});
BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
