import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import packageJson from "../../package.json" with { type: "json" };

import { checkLatestVersion } from "./checkVersion.ts";
import { handleCancellation } from "./handleCancellation.ts";

const commandLoaders = {
  aws: () => import("./commands/aws.ts").then(({ awsCommand }) => awsCommand),
  cloudflare: () =>
    import("./commands/cloudflare.ts").then(
      ({ cloudflareCommand }) => cloudflareCommand,
    ),
  deploy: () =>
    import("./commands/deploy.ts").then(({ deployCommand }) => deployCommand),
  dev: () => import("./commands/dev.ts").then(({ devCommand }) => devCommand),
  destroy: () =>
    import("./commands/deploy.ts").then(({ destroyCommand }) => destroyCommand),
  plan: () =>
    import("./commands/deploy.ts").then(({ planCommand }) => planCommand),
  tail: () =>
    import("./commands/tail.ts").then(({ tailCommand }) => tailCommand),
  logs: () =>
    import("./commands/logs.ts").then(({ logsCommand }) => logsCommand),
  login: () =>
    import("./commands/login.ts").then(({ loginCommand }) => loginCommand),
  profile: () =>
    import("./commands/profile.ts").then(
      ({ profileCommand }) => profileCommand,
    ),
  state: () =>
    import("./commands/state.ts").then(({ stateCommand }) => stateCommand),
  sync: () =>
    import("./commands/sync.ts").then(({ syncCommand }) => syncCommand),
  unsafe: () =>
    import("./commands/nuke.ts").then(({ unsafeCommand }) => unsafeCommand),
};
type CommandName = keyof typeof commandLoaders;
const commandNames = Object.keys(commandLoaders) as CommandName[];

const placeholder = (name: CommandName) =>
  name === "unsafe"
    ? Command.make(name, {}).pipe(
        Command.withDescription("Dangerous, irreversible operations."),
      )
    : Command.make(name, {});

const makeCli = async (args: readonly string[]) => {
  const selected = commandNames.find((name) => args.includes(name));
  const loadAll = args.includes("--completions");
  const loadedCommands = await Promise.all(
    commandNames.map((name) =>
      loadAll || name === selected ? commandLoaders[name]() : placeholder(name),
    ),
  );
  const root = Command.make("alchemy", {}).pipe(
    Command.withSubcommands(loadedCommands),
  );
  const cli = Command.run(root, { version: packageJson.version });
  return selected === undefined
    ? {
        cli: cli as Effect.Effect<void, any, never>,
        needsCommandServices: false as const,
      }
    : { cli, needsCommandServices: true as const };
};

const baseServices = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  PlatformServices,
);

const commandServices = Layer.unwrap(
  Effect.promise(async () => {
    const [{ TelemetryLive }, FetchHttpClient, { selectCli }] =
      await Promise.all([
        import("../Telemetry/Layer.ts"),
        import("effect/unstable/http/FetchHttpClient"),
        import("./selectCli.ts"),
      ]);
    return Layer.mergeAll(
      Layer.provide(ProfileLive, PlatformServices),
      Layer.provide(CredentialsStoreLive, PlatformServices),
      Layer.succeed(ArtifactStore, createArtifactStore()),
      FetchHttpClient.layer,
      TelemetryLive,
      selectCli(),
    );
  }),
);

const program = Effect.promise(() => makeCli(process.argv.slice(2))).pipe(
  Effect.flatMap((command) => {
    return command.needsCommandServices
      ? Effect.gen(function* () {
          yield* checkLatestVersion;
          return yield* command.cli;
        }).pipe(Effect.provide(Layer.merge(baseServices, commandServices)))
      : Effect.gen(function* () {
          yield* checkLatestVersion;
          return yield* command.cli;
        }).pipe(Effect.provide(baseServices));
  }),
  Effect.scoped,
);

export const main = handleCancellation(program);
