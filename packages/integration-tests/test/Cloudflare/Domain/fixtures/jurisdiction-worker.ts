import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counters, serve } from "./counter-model.ts";

/** The counter model on Durable Objects restricted to the EU jurisdiction. */
export default class DomainJurisdictionWorker extends Cloudflare.Worker<DomainJurisdictionWorker>()(
  "DomainJurisdictionWorker",
  { main: import.meta.url },
  serve.pipe(
    Effect.provide(
      Counters.layer(Layer.empty).pipe(
        Layer.provide(DomainCloudflare.durableObjects({ jurisdiction: "eu" })),
      ),
    ),
  ),
) {}
