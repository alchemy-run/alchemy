import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { app, WorkerGateway } from "../conformance/app.ts";

/** The conformance program in a Worker: its bindings run in a second Worker. */
export default class GatewayedWorker extends Cloudflare.Worker<GatewayedWorker>()(
  "GatewayedWorker",
  { main: import.meta.url },
  app.pipe(Effect.provide(WorkerGateway)),
) {}
