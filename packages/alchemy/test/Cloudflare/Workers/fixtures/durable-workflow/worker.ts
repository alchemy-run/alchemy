import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

export type { PollResult } from "./app.ts";

/** The test workflows on Durable Objects. */
export default class DurableWorkflowWorker extends Cloudflare.Worker<DurableWorkflowWorker>()(
  "DurableWorkflowWorker",
  { main: import.meta.url },
  app.pipe(Effect.provide(Cloudflare.Workflows.DurableObjectEngine(WorkflowsLive))),
) {}
