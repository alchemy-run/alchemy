import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

/** The test workflows on Cloudflare Workflows. */
export default class EffectWorkflowsWorker extends Cloudflare.Worker<EffectWorkflowsWorker>()(
  "EffectWorkflowsWorker",
  { main: import.meta.url },
  app.pipe(Effect.provide(Cloudflare.EffectWorkflows(WorkflowsLive))),
) {}
