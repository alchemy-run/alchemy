import * as Layer from "effect/Layer";
import * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Credentials from "./Credentials.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { QueueProviderLocal } from "./Queue/Queue.ts";
import { QueueConsumerProviderLocal } from "./Queue/QueueConsumer.ts";
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
  QueueProviderLocal(),
  QueueConsumerProviderLocal(),
).pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  RpcServer.launch,
);
