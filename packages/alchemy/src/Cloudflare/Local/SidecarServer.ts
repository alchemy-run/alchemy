import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AlchemyContext from "../../AlchemyContext.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../../Auth/Credentials.ts";
import { ProfileLive } from "../../Auth/Profile.ts";
import * as RpcServer from "../../Sidecar/RpcServer.ts";
import * as RpcServices from "../../Sidecar/RpcServices.ts";
import {
  httpServer,
  PlatformServices,
  runMain,
} from "../../Util/PlatformServices.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as Credentials from "../Credentials.ts";
import { Sidecar, SidecarSchema } from "./Sidecar.ts";
import { SidecarHandlers } from "./SidecarHandlers.ts";

const apiServices = Layer.merge(
  Credentials.fromAuthProvider(),
  CloudflareEnvironment.fromProfile(),
).pipe(
  Layer.provide(CloudflareAuth),
  Layer.provide(Layer.succeed(AuthProviders, {})),
  Layer.provide(ProfileLive),
  Layer.provide(CredentialsStoreLive),
);

const runtimeServices = SidecarHandlers.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const { accountId } =
          yield* CloudflareEnvironment.CloudflareEnvironment;
        const { dotAlchemy } = yield* AlchemyContext.AlchemyContext;
        const path = yield* Path.Path;
        return RuntimeServices.layer({
          accountId,
          storage: path.join(dotAlchemy, "local"),
        });
      }),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(apiServices, FetchHttpClient.layer, httpServer()),
  ),
);

const services = Layer.provideMerge(
  Layer.provideMerge(runtimeServices, RpcServices.layer(import.meta.url)),
  PlatformServices,
);

RpcServer.makeRpcServer(Sidecar.asEffect(), SidecarSchema).pipe(
  Effect.provide(services),
  Effect.scoped,
  runMain,
);
