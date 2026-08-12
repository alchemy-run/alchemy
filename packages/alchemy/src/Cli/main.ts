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

const deploy = () => import("./commands/deploy.ts");

const commandLoaders = {
  aws: () => import("./commands/aws.ts").then((aws) => aws.awsCommand),
  cloudflare: () =>
    import("./commands/cloudflare.ts").then(
      (cloudflare) => cloudflare.cloudflareCommand,
    ),
  deploy: () => deploy().then((deploy) => deploy.deployCommand),
  dev: () => import("./commands/dev.ts").then((dev) => dev.devCommand),
  destroy: () => deploy().then((deploy) => deploy.destroyCommand),
  plan: () => deploy().then((deploy) => deploy.planCommand),
  tail: () => import("./commands/tail.ts").then((tail) => tail.tailCommand),
  logs: () => import("./commands/logs.ts").then((logs) => logs.logsCommand),
  login: () =>
    import("./commands/login.ts").then((login) => login.loginCommand),
  profile: () =>
    import("./commands/profile.ts").then((profile) => profile.profileCommand),
  state: () =>
    import("./commands/state.ts").then((state) => state.stateCommand),
  sync: () => import("./commands/sync.ts").then((sync) => sync.syncCommand),
  unsafe: () => import("./commands/nuke.ts").then((nuke) => nuke.unsafeCommand),
};
type CommandName = keyof typeof commandLoaders;
const commandNames = Object.keys(commandLoaders) as CommandName[];

const makeCli = async (args: readonly string[]) => {
  const selected = commandNames.find((name) => args.includes(name));
  const loadAll = args.includes("--completions");
  // Effect needs every top-level name to render root help. Handlerless
  // commands preserve that list without importing their implementations.
  const loadedCommands = await Promise.all(
    commandNames.map((name) =>
      loadAll || name === selected
        ? commandLoaders[name]()
        : Command.make(name, {}),
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
