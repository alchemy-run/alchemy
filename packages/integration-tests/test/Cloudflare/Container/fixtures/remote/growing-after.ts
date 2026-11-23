import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RemoteContainerObject } from "./object.ts";

/**
 * `GrowingRemoteWorker` after it gains {@link RemoteContainerObject}, whose
 * fleet Container needs the namespace this deploy publishes.
 */
export default class GrowingRemoteWorker extends Cloudflare.Worker<GrowingRemoteWorker>()(
  "GrowingRemoteWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* RemoteContainerObject;
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
