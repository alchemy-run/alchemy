/**
 * The front of the Domain conformance suite on Cloudflare: a Worker that
 * serves the conformance routes over the model, hosted on Durable Objects.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";

export default class DomainConformanceWorker extends Cloudflare.Worker<DomainConformanceWorker>()(
  "DomainConformanceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(
    Effect.provide(ConformanceLive.pipe(Layer.provide(DomainCloudflare.layerDurableObjects()))),
  ),
) {}
