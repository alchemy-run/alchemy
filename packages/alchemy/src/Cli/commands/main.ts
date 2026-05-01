import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { inkCLI } from "alchemy/Cli/InkCLI";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import packageJson from "../../../package.json" with { type: "json" };

import { handleCancellation } from "./_shared.ts";
import { bootstrapCommand } from "./bootstrap.ts";
import { deployCommand, destroyCommand, planCommand } from "./deploy.ts";
import { devCommand } from "./dev.ts";
import { loginCommand } from "./login.ts";
import { logsCommand } from "./logs.ts";
import { profileCommand } from "./profile.ts";
import { stateCommand } from "./state.ts";
import { tailCommand } from "./tail.ts";

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

export const main = cli.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCancellation,
);
