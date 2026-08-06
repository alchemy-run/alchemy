import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Celld",
) {}

/**
 * The Celld provider layer: the host-agnostic {@link Fleet} deployment
 * provider. Fleet *hosts* are contributed by cloud provider layers — e.g.
 * targeting AWS ECS requires `AWS.providers()` in the same stack:
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
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    Layer.orDie,
  );
