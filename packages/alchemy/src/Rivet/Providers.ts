import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import * as Worker from "../Worker/Providers.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { RivetWorkerEngine } from "./Worker.ts";

// NOTE: the collection id must NOT equal any resource type string
// ("Rivet.Cluster") — `Provider(type)` and `ProviderCollection()(id)` both
// key the Context tag on the raw string, and a collision makes the direct
// provider lookup resolve the collection service instead of the provider.
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Rivet",
) {}

/**
 * The Rivet provider layer: the {@link Cluster} provider, the portable
 * `Alchemy.Worker` provider, and the `rivet` worker engine. Cluster and
 * runner *hosts* are contributed by cloud provider layers — e.g. targeting
 * AWS ECS requires `AWS.providers()` in the same stack:
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Rivet.providers()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Cluster])).pipe(
    Layer.provide(ClusterProvider()),
    // The portable Alchemy.Worker provider + the `rivet` engine — the
    // engine is provideMerged so the worker provider's dynamic
    // `findWorkerEngine` lookup (and Durable Object caller bindings) see it
    // in the ambient stack context.
    Layer.provideMerge(Worker.providers()),
    Layer.provideMerge(RivetWorkerEngine()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
