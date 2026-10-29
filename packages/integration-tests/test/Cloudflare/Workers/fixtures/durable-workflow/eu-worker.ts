import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

/** The test workflows on Durable Objects restricted to the EU jurisdiction. */
export default class EuDurableWorkflowWorker extends Cloudflare.Worker<EuDurableWorkflowWorker>()(
  "EuDurableWorkflowWorker",
  { main: import.meta.url },
  app.pipe(
    Effect.provide(
      WorkflowsLive.pipe(
        Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine({ jurisdiction: "eu" })),
      ),
    ),
  ),
) {}
