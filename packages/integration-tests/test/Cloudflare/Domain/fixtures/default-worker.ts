import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counters, serve } from "./counter-model.ts";

/** The same counter model on the unrestricted default platform. */
export default class DomainDefaultWorker extends Cloudflare.Worker<DomainDefaultWorker>()(
  "DomainDefaultWorker",
  { main: import.meta.url },
  serve.pipe(
    Effect.provide(
      Counters.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.DurableObjects)),
    ),
  ),
) {}
