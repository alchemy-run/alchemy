import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { inkCLI } from "alchemy/Cli/InkCLI";
import { PlatformServices } from "alchemy/Util";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { execStack, ExecStackOptions } from "./deploy.ts";

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  inkCLI(),
);

const options = Schema.decodeSync(ExecStackOptions)(
  JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
);

export const exec = execStack(options).pipe(
  Effect.provide(services),
  Effect.scoped,
);
