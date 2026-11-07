import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../../Workflows/conformance/app.ts";
import { ChargeHandler, WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";

/** The conformance workflows on Durable Objects restricted to the EU jurisdiction, with their queue items on a Cloudflare Queue. */
export default class EuDurableWorkflowWorker extends Cloudflare.Worker<EuDurableWorkflowWorker>()(
  "EuDurableWorkflowWorker",
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
              Cloudflare.Workflows.layerDurableObjectEngine({ jurisdiction: "eu" }),
              JournalLive,
              Cloudflare.Workflows.DurableQueueProducer(charges),
            ),
          ),
        ),
      ),
    );
  }),
) {}
