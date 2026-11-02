import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/**
 * A Cloudflare Worker with the Edge Cloud bindings that need no instance, so it deploys
 * without an entitlement and costs nothing on STACKIT. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class EdgeDiscoveryWorker extends Cloudflare.Worker<EdgeDiscoveryWorker>()(
  "StackitEdgeDiscoveryWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const listPlans = yield* Stackit.EdgeCloud.ListPlans();
    const listReleases = yield* Stackit.EdgeCloud.ListCompatibleKubernetesReleases();

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/list-plans":
            return yield* respond(
              listPlans({ projectId: url.searchParams.get("projectId") ?? "" }),
            );
          case "/list-compatible-releases":
            return yield* respond(
              listReleases({ talosVersion: url.searchParams.get("talosVersion") ?? "" }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed({ notFound: true })),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.EdgeCloud.ListPlansHttp,
        Stackit.EdgeCloud.ListCompatibleKubernetesReleasesHttp,
      ),
    ),
  ),
) {}
