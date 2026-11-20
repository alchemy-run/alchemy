/**
 * The conformance front with every Durable Object created in Asia-Pacific:
 * a caller elsewhere reaches a front near them, whose objects are far away.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { ConformanceLive } from "../../../Domain/conformance/model.ts";

export default class DomainLatencyFarWorker extends Cloudflare.Worker<DomainLatencyFarWorker>()(
  "DomainLatencyFarWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(
    Effect.provide(
      ConformanceLive.pipe(
        Layer.provide(DomainCloudflare.layerDurableObjects({ locationHint: "apac" })),
      ),
    ),
  ),
) {}
