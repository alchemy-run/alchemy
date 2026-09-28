import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import { CelldWorkerProvider, Worker } from "./Worker.ts";
import { Application, ApplicationProvider } from "./Application.ts";
import { Bootstrap, BootstrapProvider } from "./Bootstrap.ts";
import { Namespace, NamespaceProvider } from "./KV/Namespace.ts";
import { Bucket, BucketProvider } from "./R2/Bucket.ts";
import { Queue, QueueProvider } from "./Queues/Queue.ts";
import { Database, DatabaseProvider } from "./D1/Database.ts";
import { FleetStorageS3 } from "./FleetStorageS3.ts";
import { ManagementBindings } from "./ManagementBindings.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Celld",
) {}

/**
 * The Celld provider layer: the {@link Fleet} and `Celld.Worker`
 * providers. The fleet *host* is a separate Layer composed alongside —
 * targeting AWS ECS is `Celld.EcsFleet()`, which also needs `AWS.providers()`
 * in the same stack (it contributes the `Random` provider the per-worker
 * gateway secret is minted with):
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Fleet,
      Worker,
      Application,
      Bootstrap,
      Namespace,
      Bucket,
      Queue,
      Database,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        FleetProvider(),
        CelldWorkerProvider(),
        ApplicationProvider(),
        BootstrapProvider(),
        NamespaceProvider(),
        BucketProvider(),
        QueueProvider(),
        DatabaseProvider(),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(FleetStorageS3, ManagementBindings)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
