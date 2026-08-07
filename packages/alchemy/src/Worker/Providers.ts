import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Worker, WorkerProvider } from "./Worker.ts";

// NOTE: the collection id must NOT equal the resource type string
// ("Alchemy.Worker") — `Provider(type)` and `ProviderCollection()(id)` both
// key the Context tag on the raw string, and a collision makes the direct
// provider lookup resolve the collection service instead of the provider.
export class Providers extends Provider.ProviderCollection<Providers>()(
  "Alchemy.Workers",
) {}

/**
 * The portable `Alchemy.Worker` provider layer. Engines are contributed
 * separately by cloud provider layers (`Celld.providers()` registers the
 * `celld` engine and already composes this collection — stacks using a
 * Celld target need nothing extra).
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Worker as any])).pipe(
    Layer.provide(WorkerProvider()),
    Layer.orDie,
  );
