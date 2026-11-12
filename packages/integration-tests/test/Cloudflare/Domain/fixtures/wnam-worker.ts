import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CountersLive, serve } from "./counter-model.ts";

/** The counter model, creating every new Durable Object in western North America. */
export default class DomainPlacedCounterWorker extends Cloudflare.Worker<DomainPlacedCounterWorker>()(
  "DomainPlacedCounterWorker",
  { main: import.meta.url },
  serve("wnam").pipe(
    Effect.provide(
      CountersLive.pipe(
        Layer.provide(DomainCloudflare.layerDurableObjects({ locationHint: "wnam" })),
      ),
    ),
  ),
) {}
