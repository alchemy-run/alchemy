import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { RivetWorkerProvider, RivetWorkerResource } from "./Worker.ts";

// NOTE: the collection id must NOT equal any resource type string
// ("Rivet.Cluster") — `Provider(type)` and `ProviderCollection()(id)` both
// key the Context tag on the raw string, and a collision makes the direct
// provider lookup resolve the collection service instead of the provider.
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Rivet",
) {}

/**
 * The Rivet provider layer: the {@link Cluster} and `Rivet.Worker`
 * providers. Cluster and runner *hosts* are contributed by cloud provider
 * layers — e.g. targeting AWS ECS requires `AWS.providers()` in the same
 * stack:
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Rivet.providers()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Cluster, RivetWorkerResource as any]),
  ).pipe(
    Layer.provide(ClusterProvider()),
    Layer.provide(RivetWorkerProvider()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
