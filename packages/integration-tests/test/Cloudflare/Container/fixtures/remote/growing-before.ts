import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * `GrowingRemoteWorker` before it binds a Container: deployed first, so the
 * next deploy ({@link ./growing-after.ts}) updates a live Worker that gains
 * a Durable Object class backed by a fleet Container.
 */
export default class GrowingRemoteWorker extends Cloudflare.Worker<GrowingRemoteWorker>()(
  "GrowingRemoteWorker",
  { main: import.meta.url },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
) {}
