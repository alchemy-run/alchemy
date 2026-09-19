import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { credentials, Services } from "@distilled.cloud/forgejo";
import { paginate } from "alchemy/Forgejo";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// Run from the repository root: bun packages/alchemy/test/Forgejo/support/fixture.ts [check|down]
const container = "alchemy-forgejo-1425";
const volume = "alchemy-forgejo-1425-data";
const baseUrl = "http://127.0.0.1:31425";
const username = "alchemy-admin";

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* Effect.sync(() => process.cwd());
  const directory = path.join(cwd, ".alchemy", "forgejo");
  const config = path.join(directory, "fixture.json");
  const command = Effect.fn(function* (args: string[]) {
    const handle = yield* runner.spawn(
      ChildProcess.make("docker", args, { stdout: "pipe", stderr: "ignore" }),
    );
    const text = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
    const code = yield* handle.exitCode;
    if (code !== 0)
      return yield* Effect.fail(
        new Error(`Docker ${args[0]} failed (exit ${code})`),
      );
    return text;
  });
  const down = yield* Effect.sync(() => process.argv.includes("down"));
  if (down) {
    yield* command(["rm", "-f", container]);
    yield* command(["volume", "rm", volume]);
    yield* fs.remove(config, { force: true });
    yield* fs.remove(path.join(directory, "runtime-home"), {
      recursive: true,
      force: true,
    });
    return;
  }
  const check = yield* Effect.sync(() => process.argv.includes("check"));
  if (check) {
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          baseUrl: Schema.String,
          token: Schema.String,
          username: Schema.String,
        }),
      ),
    )(yield* fs.readFileString(config));
    yield* Effect.gen(function* () {
      const repos = yield* paginate(Services.user.userCurrentListRepos, {});
      const orgs = yield* paginate(
        Services.organization.orgListCurrentUserOrgs,
        {},
      );
      const tokens = yield* paginate(Services.admin.adminListUserAccessTokens, {
        username: value.username,
      });
      const variables = yield* paginate(Services.user.getUserVariablesList, {});
      const remaining = {
        repositories: repos.length,
        organizations: orgs.length,
        tokens: tokens.filter((t) => t.name !== "alchemy-bootstrap").length,
        variables: variables.length,
      };
      if (Object.values(remaining).some((count) => count !== 0))
        return yield* Effect.fail(
          new Error(`Fixture resources remain: ${JSON.stringify(remaining)}`),
        );
      yield* Effect.logInfo(
        "Forgejo fixture census: no repositories, organizations, managed tokens, or user variables remain.",
      );
    }).pipe(Effect.provide(credentials(value)));
    // User secrets have no list API; inspect only row counts on the owned fixture.
    const hiddenRows = (yield* command([
      "exec",
      "--user",
      "git",
      container,
      "sqlite3",
      "-readonly",
      "/data/gitea/gitea.db",
      "SELECT (SELECT COUNT(*) FROM secret) + (SELECT COUNT(*) FROM team) + (SELECT COUNT(*) FROM webhook);",
    ])).trim();
    if (hiddenRows !== "0")
      return yield* Effect.fail(
        new Error(`Fixture secret/team/webhook rows remain: ${hiddenRows}`),
      );
    yield* Effect.logInfo(
      "Forgejo fixture database census: zero secret, team, and webhook rows.",
    );
    return;
  }
  if (yield* fs.exists(config)) {
    yield* command(["start", container]);
    return;
  }
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.chmod(directory, 0o700);
  yield* command(["volume", "create", volume]);
  const existing = yield* command([
    "ps",
    "-a",
    "--filter",
    `name=^/${container}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (existing.trim() === container) yield* command(["start", container]);
  else
    yield* command([
      "run",
      "-d",
      "--name",
      container,
      "--memory",
      "1g",
      "--cpus",
      "2",
      "-p",
      "127.0.0.1:31425:3000",
      "-v",
      `${volume}:/data`,
      "-e",
      "FORGEJO__security__INSTALL_LOCK=true",
      "-e",
      "FORGEJO__database__DB_TYPE=sqlite3",
      "-e",
      `FORGEJO__server__ROOT_URL=${baseUrl}/`,
      "-e",
      "FORGEJO__server__DISABLE_SSH=true",
      "-e",
      "FORGEJO__service__DISABLE_REGISTRATION=true",
      "-e",
      "FORGEJO__service__REQUIRE_SIGNIN_VIEW=true",
      "-e",
      "FORGEJO__webhook__ALLOWED_HOST_LIST=*",
      "-e",
      "FORGEJO__log__LEVEL=Error",
      "codeberg.org/forgejo/forgejo:16.0.3@sha256:7c4e1db440be7b2ca685b49d0d7864cdd78e92431f531bf7893659def8200fc5",
    ]);
  const cli = (args: string[]) =>
    command([
      "exec",
      "--user",
      "git",
      container,
      "forgejo",
      "--config",
      "/data/gitea/conf/app.ini",
      ...args,
    ]);
  yield* cli(["admin", "user", "list"]).pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
  );
  const password = yield* Effect.sync(
    () => crypto.randomUUID() + crypto.randomUUID(),
  );
  yield* cli([
    "admin",
    "user",
    "create",
    "--username",
    username,
    "--password",
    password,
    "--email",
    "alchemy-admin@example.invalid",
    "--admin",
    "--must-change-password=false",
  ]);
  const token = (yield* cli([
    "admin",
    "user",
    "generate-access-token",
    "--username",
    username,
    "--token-name",
    "alchemy-bootstrap",
    "--scopes",
    "all",
    "--raw",
  ])).trim();
  if (!/^[a-f0-9]{40}$/.test(token))
    return yield* Effect.fail(
      new Error("Forgejo did not return a valid bootstrap token."),
    );
  yield* fs.writeFileString(
    config,
    JSON.stringify({ baseUrl, username, token, container, volume }),
  );
  yield* fs.chmod(config, 0o600);
});

BunRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  ),
);
