import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import * as Worker from "../Worker/Providers.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import { CelldWorkerEngine } from "./Worker.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Celld",
) {}

/**
 * The Celld provider layer: the {@link Fleet} provider, the portable
 * `Alchemy.Worker` provider, and the `celld` worker engine. Fleet *hosts*
 * are contributed by cloud provider layers — e.g. targeting AWS ECS
 * requires `AWS.providers()` in the same stack:
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Fleet])).pipe(
    Layer.provide(FleetProvider()),
    // The portable Alchemy.Worker provider + the `celld` engine — the
    // engine is provideMerged so the worker provider's dynamic
    // `findWorkerEngine` lookup (and Durable Object caller bindings) see it
    // in the ambient stack context.
    Layer.provideMerge(Worker.providers()),
    Layer.provideMerge(CelldWorkerEngine()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
