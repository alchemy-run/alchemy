import * as Celld from "@alchemy.run/celld";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

export type { Status } from "./app.ts";

/** The engine conformance workflows on Celld Durable Objects. */
export default class DurableWorkflowWorker extends Celld.Worker<DurableWorkflowWorker>()(
  "DurableWorkflowWorker",
  { main: import.meta.url },
  app.pipe(
    Effect.provide(WorkflowsLive.pipe(Layer.provideMerge(Celld.Workflows.DurableObjectEngine))),
  ),
) {}
