import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The instance the bindings read. See `../edge.ts` for `STACKIT_TEST_EDGE` and the cost. */
export const Bound = Stackit.EdgeCloud.Instance("EdgeBindingsInstance", {
  planId: process.env.STACKIT_TEST_EDGE ?? "",
});

/**
 * A Cloudflare Worker with the Edge Cloud bindings on an instance. One route per binding;
 * each answers `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 * Credentials stay in the Worker.
 */
export default class EdgeBindingsWorker extends Cloudflare.Worker<EdgeBindingsWorker>()(
  "StackitEdgeBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Bound;
    const getInstance = yield* Stackit.EdgeCloud.GetInstance(instance);
    const listInstances = yield* Stackit.EdgeCloud.ListInstances(instance);
    const getKubeconfig = yield* Stackit.EdgeCloud.GetKubeconfig(instance);
    const getToken = yield* Stackit.EdgeCloud.GetToken(instance);

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
          case "/get-instance":
            return yield* respond(getInstance());
          case "/list-instances":
            return yield* respond(listInstances());
          case "/get-kubeconfig":
            return yield* respond(
              getKubeconfig({ expirationSeconds: 600 }).pipe(
                Effect.map(({ kubeconfig }) => ({
                  redacted: Redacted.isRedacted(kubeconfig),
                  clusters: JSON.parse(Redacted.value(kubeconfig)).clusters.length,
                })),
              ),
            );
          case "/get-token":
            return yield* respond(
              getToken({ expirationSeconds: 600 }).pipe(
                Effect.map(({ token }) => ({
                  redacted: Redacted.isRedacted(token),
                  minted: Redacted.value(token).length > 0,
                })),
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
        Stackit.EdgeCloud.GetInstanceHttp,
        Stackit.EdgeCloud.ListInstancesHttp,
        Stackit.EdgeCloud.GetKubeconfigHttp,
        Stackit.EdgeCloud.GetTokenHttp,
      ),
    ),
  ),
) {}
