import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { execStack, ExecStackOptions } from "alchemy/Cli/Commands";
import { inkCLI } from "alchemy/Cli/InkCLI";
import { PlatformServices, runMain } from "alchemy/Util";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

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
