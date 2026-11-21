/**
 * The conformance front's next deploy: the model at its next version, which
 * rebuilds the tallies (see `rebuild` in the conformance suite).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { ConformanceLiveV1 } from "../../../Domain/conformance/model.ts";

export default class DomainConformanceWorker extends Cloudflare.Worker<DomainConformanceWorker>()(
  "DomainConformanceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(
    Effect.provide(ConformanceLiveV1.pipe(Layer.provide(DomainCloudflare.layerDurableObjects()))),
  ),
) {}
