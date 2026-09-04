import * as Layer from "effect/Layer";
import { DockerLive } from "../Docker/Docker.ts";
import { DevIngressRouteProvider } from "../Local/DevIngressClient.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import { LocalContainerProvider } from "./Containers/LocalContainerProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ProviderLocal as D1ProviderLocal } from "./D1/Database.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { ProviderLocal } from "./Queues/Queue.ts";
import { ConsumerProviderLocal } from "./Queues/Consumer.ts";
import { SecretProviderLocal } from "./SecretsStore/Secret.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";

const cloudflareServices = Layer.provide(
  Layer.merge(
    Credentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
  ),
  CloudflareAuth,
);

Layer.mergeAll(
  LocalWorkerProvider(),
  LocalContainerProvider(),
  ProviderLocal(),
  ConsumerProviderLocal(),
  D1ProviderLocal(),
  SecretProviderLocal(),
  // The dev ingress is hosted here (it is built on the workerd runtime);
  // other dev processes register their routes through this RPC provider.
  DevIngressRouteProvider(),
).pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  Layer.provide(DockerLive),
  RpcServer.launch,
);
