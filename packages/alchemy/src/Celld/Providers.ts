import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import { CelldWorkerProvider, Worker } from "./Worker.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Celld",
) {}

/**
 * The Celld provider layer: the {@link Fleet} and `Celld.Worker`
 * providers. The fleet *host* is a separate Layer composed alongside —
 * targeting AWS ECS is `Celld.Ecs()`, which also needs `AWS.providers()`
 * in the same stack (it contributes the `Random` provider the per-worker
 * gateway secret is minted with):
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Fleet, Worker])).pipe(
    Layer.provide(FleetProvider()),
    Layer.provide(CelldWorkerProvider()),
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
