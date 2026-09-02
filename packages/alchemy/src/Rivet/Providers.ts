import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { RivetWorkerProvider, Worker } from "./Worker.ts";

// NOTE: the collection id must NOT equal any resource type string
// ("Rivet.Cluster") — `Provider(type)` and `ProviderCollection()(id)` both
// key the Context tag on the raw string, and a collision makes the direct
// provider lookup resolve the collection service instead of the provider.
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Rivet",
) {}

/**
 * The Rivet provider layer: the {@link Cluster} and `Rivet.Worker`
 * providers. The platform the engine and runners run on is a separate
 * `Rivet.Host` layer merged alongside — `Rivet.Ecs()` for AWS ECS, which
 * also needs `AWS.providers()` in the same stack (it composes AWS
 * resources and mints the admin token through its `Random` provider):
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Cluster, Worker])).pipe(
    Layer.provide(ClusterProvider()),
    Layer.provide(RivetWorkerProvider()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
