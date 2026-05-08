import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";
import { selectCli } from "./selectCli.ts";

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  selectCli(),
);

export const exec = () =>
  execStack(
    Schema.decodeSync(ExecStackOptions)(
      JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
    ),
  ).pipe(Effect.provide(services), Effect.scoped);
