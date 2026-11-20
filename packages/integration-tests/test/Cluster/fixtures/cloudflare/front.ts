/** The Cloudflare suite's front: a Worker calling everything through the gateway. */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { frontApp } from "../app.ts";
import Generation from "./generation.ts";

export default class Front extends Cloudflare.Worker<Front>()(
  "ClusterCloudflareFront",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  // The cluster's classes need Cluster.providers(), which the Stack provides.
  Effect.gen(function* () {
    const app = yield* frontApp();
    // Declared inline: yielding it also deploys it.
    const generations = yield* Generation;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, id = "x"] = new URL(request.url, "http://front").pathname.split("/");
        if (route === "generation") {
          const generation = yield* generations.getByName(id);
          return yield* HttpServerResponse.json({ value: yield* generation.Get() });
        }
        return yield* app.fetch;
      }).pipe(
        // A failed call answers with its cause, which the tests print.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }) as unknown as Effect.Effect<Cloudflare.Workers.WorkerShape, never, never>,
) {}
