import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import { makeDevLogOpener } from "../Local/DevLog.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import { forwardSidecarLogs } from "../Local/RpcSpawner.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { handleCliErrors } from "./commands/_shared.ts";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";
import * as CliKit from "./CliKit/index.ts";
import { selectCliServices } from "./selectCli.ts";

// Interactive dev/deploy runs use the Ink progress UI; CI, redirected output,
// and other non-interactive terminals still select the append-only renderer.
// `ALCHEMY_TUI` remains the explicit override in either direction.
const makeServices = Layer.merge(
  Layer.provideMerge(selectCliServices(), CliKit.layer()),
  RpcProviderProxy.fromEnv(),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(AlchemyContextLive, ProfileStoreLive, CredentialsStoreLive),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
    ),
  ),
);

export const exec = () => {
  const options = Schema.decodeSync(ExecStackOptions)(
    JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
  );
  return Effect.gen(function* () {
    // Subscribe to the spawner's sidecar log stream BEFORE the stack runs:
    // this process owns the terminal renderer, so sidecar output printed
    // here lands in chronological order with the run's own lines instead of
    // racing the shared tty. No-op outside dev. The mixed tail is also teed
    // to log/{stage}/{timestamp}.log; per-resource output lands in
    // log/{stage}/{logicalId}/ via the local providers.
    const devLog = yield* (yield* makeDevLogOpener)(options.stage);
    yield* forwardSidecarLogs((entry) =>
      devLog.writeLine(`[${entry.channel}] ${entry.line}`),
    );
    return yield* execStack(options);
  }).pipe(Effect.provide(makeServices), Effect.scoped, handleCliErrors);
};
