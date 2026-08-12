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

const commandNames = [
  "aws",
  "cloudflare",
  "deploy",
  "dev",
  "destroy",
  "plan",
  "tail",
  "logs",
  "login",
  "profile",
  "state",
  "sync",
  "unsafe",
] as const;
type CommandName = (typeof commandNames)[number];

const loadCommand = async (name: CommandName) => {
  switch (name) {
    case "aws": {
      const { awsCommand } = await import("./commands/aws.ts");
      return awsCommand;
    }
    case "cloudflare": {
      const { cloudflareCommand } = await import("./commands/cloudflare.ts");
      return cloudflareCommand;
    }
    case "deploy":
    case "destroy":
    case "plan": {
      const commands = await import("./commands/deploy.ts");
      return name === "deploy"
        ? commands.deployCommand
        : name === "destroy"
          ? commands.destroyCommand
          : commands.planCommand;
    }
    case "dev": {
      const { devCommand } = await import("./commands/dev.ts");
      return devCommand;
    }
    case "tail": {
      const { tailCommand } = await import("./commands/tail.ts");
      return tailCommand;
    }
    case "logs": {
      const { logsCommand } = await import("./commands/logs.ts");
      return logsCommand;
    }
    case "login": {
      const { loginCommand } = await import("./commands/login.ts");
      return loginCommand;
    }
    case "profile": {
      const { profileCommand } = await import("./commands/profile.ts");
      return profileCommand;
    }
    case "state": {
      const { stateCommand } = await import("./commands/state.ts");
      return stateCommand;
    }
    case "sync": {
      const { syncCommand } = await import("./commands/sync.ts");
      return syncCommand;
    }
    case "unsafe": {
      const { unsafeCommand } = await import("./commands/nuke.ts");
      return unsafeCommand;
    }
  }
};

const makeCli = async (args: readonly string[]) => {
  const selected = commandNames.find((name) => args.includes(name));
  const loadAll = args.includes("--completions");
  // Effect needs every top-level name to render root help. Handlerless
  // commands preserve that list without importing their implementations.
  const loadedCommands = await Promise.all(
    commandNames.map((name) =>
      loadAll || name === selected ? loadCommand(name) : Command.make(name, {}),
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
