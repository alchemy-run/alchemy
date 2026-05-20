import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AlchemyContext from "../AlchemyContext.ts";
import * as RpcProcessContext from "../Local/RpcProcessContext.ts";
import { RpcServerBun } from "../Local/RpcServerBun.ts";
import { PlatformServices, runMain } from "../Util/PlatformServices.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Credentials from "./Credentials.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;
    const { dotAlchemy } = yield* AlchemyContext.AlchemyContext;
    const path = yield* Path.Path;
    return RuntimeServices.layerRuntime({
      api: {
        accountId,
      },
      storage: {
        directory: path.join(dotAlchemy, "local"),
      },
    });
  }),
);

const cloudflareServices = Layer.provide(
  Layer.merge(
    Credentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
  ),
  CloudflareAuth,
);

const server = RpcServerBun.pipe(
  Layer.provide(LocalWorkerProvider()),
  Layer.provide(Layer.merge(runtime, RuntimeServices.layerLocalProxy(1337))),
  Layer.provide(cloudflareServices),
  Layer.provide(RpcProcessContext.fromEnv()),
  Layer.provide(Layer.merge(PlatformServices, FetchHttpClient.layer)),
);

const program = Layer.launch(server);

runMain(program.pipe(Effect.scoped));
