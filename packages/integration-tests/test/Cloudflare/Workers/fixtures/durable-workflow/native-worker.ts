import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../../Workflows/conformance/app.ts";
import { ChargeHandler, WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";

/** The conformance workflows on Cloudflare Workflows, through NativeEngine, with their queue items on a Cloudflare Queue. */
export default class NativeEngineWorker extends Cloudflare.Worker<NativeEngineWorker>()(
  "NativeEngineWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const charges = yield* Cloudflare.Queues.Queue("ConformanceCharges");
    return yield* app.pipe(
      Effect.provide(
        Layer.mergeAll(
          WorkflowsLive,
          Cloudflare.Workflows.DurableQueueWorker(charges, [ChargeHandler]),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Cloudflare.Workflows.NativeEngine,
              JournalLive,
              Cloudflare.Workflows.DurableQueueProducer(charges),
            ),
          ),
        ),
      ),
    );
  }),
) {}
