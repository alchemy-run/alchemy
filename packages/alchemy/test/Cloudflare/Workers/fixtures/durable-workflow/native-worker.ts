import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

/** The test workflows on Cloudflare Workflows, through NativeEngine. */
export default class NativeEngineWorker extends Cloudflare.Worker<NativeEngineWorker>()(
  "NativeEngineWorker",
  { main: import.meta.url },
  app.pipe(Effect.provide(Cloudflare.Workflows.NativeEngine(WorkflowsLive))),
) {}
