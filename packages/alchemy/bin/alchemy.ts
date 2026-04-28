import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import packageJson from "../package.json" with { type: "json" };
import { AlchemyContextLive } from "../src/AlchemyContext.ts";
import { inkCLI } from "../src/Cli/InkCLI.tsx";
import { TelemetryLive } from "../src/Telemetry/Layer.ts";
import { PlatformServices, runMain } from "../src/Util/PlatformServices.ts";

import { handleCancellation } from "./commands/_shared.ts";
import { bootstrapCommand } from "./commands/bootstrap.ts";
import {
  deployCommand,
  destroyCommand,
  planCommand,
} from "./commands/deploy.ts";
import { loginCommand } from "./commands/login.ts";
import { logsCommand } from "./commands/logs.ts";
import { profileCommand } from "./commands/profile.ts";
import { stateCommand } from "./commands/state.ts";
import { tailCommand } from "./commands/tail.ts";

const root = Command.make("alchemy", {}).pipe(
  Command.withSubcommands([
    bootstrapCommand,
    deployCommand,
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
