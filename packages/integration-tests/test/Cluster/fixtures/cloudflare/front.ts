/** The Cloudflare suite's front: a Worker calling everything through the gateway. */
import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Effect from "effect/Effect";
import { frontApp } from "../app.ts";

export default class Front extends Cloudflare.Worker<Front>()(
  "ClusterCloudflareFront",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  // The cluster's classes need Cluster.providers(), which the Stack provides.
  frontApp() as unknown as Effect.Effect<Cloudflare.Workers.WorkerShape, never, never>,
) {}
