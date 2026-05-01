import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { inkCLI } from "alchemy/Cli/InkCLI";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  inkCLI(),
);

const options = Schema.decodeSync(ExecStackOptions)(
  JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
);

execStack(options).pipe(Effect.provide(services), Effect.scoped, runMain);
