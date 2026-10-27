import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A private service that returns RPC methods, which a public invoker
 * grant must not expose. Deployed from {@link ../InvokeService.test.ts}.
 */
export default class PublicGrant extends GCP.Run.Service<PublicGrant>()(
  "PublicGrant",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    return {
      secret: () => Effect.succeed("should never be public"),
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
