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

const descriptions: Partial<Record<CommandName, string>> = {
  unsafe: "Dangerous, irreversible operations.",
};

const placeholder = (name: CommandName) => {
  const command = Command.make(name, {});
  const description = descriptions[name];
  return description === undefined
    ? command
    : command.pipe(Command.withDescription(description));
};

const selectedCommand = (args: readonly string[]): CommandName | undefined => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--log-level" || arg === "--completions") {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return commandNames.includes(arg as CommandName)
      ? (arg as CommandName)
      : undefined;
  }
  return undefined;
};

const loadCommand = async (name: CommandName) => {
  switch (name) {
    case "aws":
      return (await import("./commands/aws.ts")).awsCommand;
    case "cloudflare":
      return (await import("./commands/cloudflare.ts")).cloudflareCommand;
    case "deploy":
      return (await import("./commands/deploy.ts")).deployCommand;
    case "dev":
      return (await import("./commands/dev.ts")).devCommand;
    case "destroy":
      return (await import("./commands/deploy.ts")).destroyCommand;
    case "plan":
      return (await import("./commands/deploy.ts")).planCommand;
    case "tail":
      return (await import("./commands/tail.ts")).tailCommand;
    case "logs":
      return (await import("./commands/logs.ts")).logsCommand;
    case "login":
      return (await import("./commands/login.ts")).loginCommand;
    case "profile":
      return (await import("./commands/profile.ts")).profileCommand;
    case "state":
      return (await import("./commands/state.ts")).stateCommand;
    case "sync":
      return (await import("./commands/sync.ts")).syncCommand;
    case "unsafe":
      return (await import("./commands/nuke.ts")).unsafeCommand;
  }
};

const loadAllCommands = async () => {
  const [
    aws,
    cloudflare,
    deploy,
    dev,
    login,
    logs,
    nuke,
    profile,
    state,
    sync,
    tail,
  ] = await Promise.all([
    import("./commands/aws.ts"),
    import("./commands/cloudflare.ts"),
    import("./commands/deploy.ts"),
    import("./commands/dev.ts"),
    import("./commands/login.ts"),
    import("./commands/logs.ts"),
    import("./commands/nuke.ts"),
    import("./commands/profile.ts"),
    import("./commands/state.ts"),
    import("./commands/sync.ts"),
    import("./commands/tail.ts"),
  ]);
  return [
    aws.awsCommand,
    cloudflare.cloudflareCommand,
    deploy.deployCommand,
    dev.devCommand,
    deploy.destroyCommand,
    deploy.planCommand,
    tail.tailCommand,
    logs.logsCommand,
    login.loginCommand,
    profile.profileCommand,
    state.stateCommand,
    sync.syncCommand,
    nuke.unsafeCommand,
  ];
};

const isInformational = (args: readonly string[]) =>
  args.some(
    (arg) =>
      arg === "--help" ||
      arg === "-h" ||
      arg === "--version" ||
      arg === "-v" ||
      arg === "--completions",
  );

const makeCli = async (
  args: readonly string[],
  load: (name: CommandName) => Promise<Command.Command.Any> = loadCommand,
) => {
  const selected = selectedCommand(args);
  const commands = args.includes("--completions")
    ? await loadAllCommands()
    : await Promise.all(
        commandNames.map((name) =>
          name === selected ? load(name) : placeholder(name),
        ),
      );
  const root = Command.make("alchemy", {}).pipe(
    Command.withSubcommands(commands as ReadonlyArray<Command.Command.Any>),
  );
  return {
    cli: Command.run(root, { version: packageJson.version }),
    needsCommandServices: selected !== undefined && !isInformational(args),
  };
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
  Effect.flatMap(({ cli, needsCommandServices }) =>
    Effect.gen(function* () {
      yield* checkLatestVersion;
      return yield* cli;
    }).pipe(
      Effect.provide(
        needsCommandServices
          ? Layer.merge(baseServices, commandServices)
          : baseServices,
      ),
    ),
  ),
  Effect.scoped,
);

export const main: Effect.Effect<void, any, never> = handleCancellation(
  program,
) as Effect.Effect<void, any, never>;

export const _internal = { isInformational, makeCli, selectedCommand };
