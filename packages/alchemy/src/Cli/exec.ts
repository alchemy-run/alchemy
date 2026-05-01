import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { PlatformServices } from "alchemy/Util";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";
import { inkCLI } from "./tui/InkCLI.tsx";

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  inkCLI(),
);

export const exec = () =>
  execStack(
    Schema.decodeSync(ExecStackOptions)(
      JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
    ),
  ).pipe(Effect.provide(services), Effect.scoped);
