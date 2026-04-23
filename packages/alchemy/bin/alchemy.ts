import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
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
  ]),
);

const cli = Command.run(root, {
  // name: "Alchemy Effect CLI",
  version: packageJson.version,
});

cli.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv(),
  ),
  Effect.provide(PlatformServices),
  Effect.scoped,
  handleCancellation,
  runMain,
);
