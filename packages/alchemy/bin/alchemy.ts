import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { inkCLI } from "alchemy/Cli/InkCLI";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import packageJson from "../package.json" with { type: "json" };

import {
  bootstrapCommand,
  deployCommand,
  destroyCommand,
  devCommand,
  handleCancellation,
  loginCommand,
  logsCommand,
  planCommand,
  profileCommand,
  stateCommand,
  tailCommand,
} from "alchemy/Cli/Commands";

const root = Command.make("alchemy", {}).pipe(
  Command.withSubcommands([
    bootstrapCommand,
    deployCommand,
    devCommand,
    destroyCommand,
    planCommand,
    tailCommand,
    logsCommand,
    loginCommand,
    profileCommand,
    stateCommand,
  ]),
);

const cli = Command.run(root, {
  // name: "Alchemy Effect CLI",
  version: packageJson.version,
});

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  TelemetryLive,
  inkCLI(),
);

cli.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCancellation,
  runMain,
);
