import { layerRuntime } from "@distilled.cloud/cloudflare-runtime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Path from "effect/Path";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as RpcProvider from "../Local/RpcProvider.ts";
import { CloudflareEnvironment } from "./CloudflareEnvironment.ts";
import type { Queue } from "./Queues/Queue.ts";
import type { Consumer } from "./Queues/Consumer.ts";

export const LOCAL_ENTRY_URL = import.meta.resolve(
  // `import.meta.resolve(<string>)` is a runtime API — TypeScript's
  // `rewriteRelativeImportExtensions` does NOT touch the string literal, so
  // we have to pick the right extension ourselves. `import.meta.url` reflects
  // the actual on-disk extension of *this* file (`.ts` when loaded from
  // `src/` under Bun or vitest, `.js` when loaded from the compiled `lib/`
  // under Node), which is exactly the signal we need.
  import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
  import.meta.url,
);

export class LocalRuntimeState extends Context.Service<
  LocalRuntimeState,
  {
    readonly queues: MutableHashMap.MutableHashMap<
      Queue["Attributes"]["queueId"],
      Queue["Attributes"]
    >;
    readonly queueConsumers: MutableHashMap.MutableHashMap<
      Consumer["Attributes"]["consumerId"],
      Consumer["Attributes"]
    >;
  }
>()("alchemy/cloudflare/LocalRuntimeState") {}

const LocalRuntimeStateLive = Layer.succeed(
  LocalRuntimeState,
  LocalRuntimeState.of({
    queues: MutableHashMap.empty(),
    queueConsumers: MutableHashMap.empty(),
  }),
);

export const localRuntimeServices = () =>
  RpcProvider.providerServicesEffect(
    Effect.gen(function* () {
      const getEnv = yield* CloudflareEnvironment;
      const { dotAlchemy } = yield* AlchemyContext;
      const path = yield* Path.Path;
      return Layer.merge(
        LocalRuntimeStateLive,
        layerRuntime({
          api: {
            accountId: getEnv.pipe(Effect.map((env) => env.accountId)),
          },
          storage: {
            directory: path.join(dotAlchemy, "local"),
          },
        }),
      );
    }),
  );

export const isLocalId = (id: string | undefined): id is string =>
  typeof id === "string" && id.startsWith("dev:");
export const isLiveId = (id: string | undefined): id is string =>
  typeof id === "string" && !id.startsWith("dev:");
export const generateLocalId = (): string => `dev:${crypto.randomUUID()}`;
