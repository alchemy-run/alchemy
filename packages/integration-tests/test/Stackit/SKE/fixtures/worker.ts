import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { smallPool } from "../pool.ts";

export const Bound = Stackit.SKE.Cluster("SkeBindingsCluster", { nodepools: [smallPool] });

/**
 * A Cloudflare Worker with every SKE binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class SkeBindingsWorker extends Cloudflare.Worker<SkeBindingsWorker>()(
  "StackitSkeBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const cluster = yield* Bound;
    const getCluster = yield* Stackit.SKE.GetCluster(cluster);
    const listClusters = yield* Stackit.SKE.ListClusters(cluster);
    const createKubeconfig = yield* Stackit.SKE.CreateKubeconfig(cluster);
    const listProviderOptions = yield* Stackit.SKE.ListProviderOptions();
    const hibernate = yield* Stackit.SKE.TriggerHibernate(cluster);
    const wakeup = yield* Stackit.SKE.TriggerWakeup(cluster);
    const maintain = yield* Stackit.SKE.TriggerMaintenance(cluster);
    const reconcile = yield* Stackit.SKE.TriggerReconcile(cluster);
    const startRotation = yield* Stackit.SKE.StartCredentialsRotation(cluster);
    const completeRotation = yield* Stackit.SKE.CompleteCredentialsRotation(cluster);

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
          case "/get-cluster":
            return yield* respond(getCluster());
          case "/list-clusters":
            return yield* respond(listClusters());
          case "/create-kubeconfig":
            // The credential itself stays in the Worker.
            return yield* respond(
              createKubeconfig({ expirationSeconds: "600" }).pipe(
                Effect.map((minted) => ({
                  expirationTimestamp: minted.expirationTimestamp,
                  returned: minted.kubeconfig !== undefined,
                })),
              ),
            );
          case "/list-provider-options":
            return yield* respond(
              listProviderOptions({ region: url.searchParams.get("region") ?? "" }),
            );
          case "/hibernate":
            return yield* respond(hibernate());
          case "/wakeup":
            return yield* respond(wakeup());
          case "/maintain":
            return yield* respond(maintain());
          case "/reconcile":
            return yield* respond(reconcile());
          case "/start-rotation":
            return yield* respond(startRotation());
          case "/complete-rotation":
            return yield* respond(completeRotation());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.SKE.GetClusterHttp,
        Stackit.SKE.ListClustersHttp,
        Stackit.SKE.CreateKubeconfigHttp,
        Stackit.SKE.ListProviderOptionsHttp,
        Stackit.SKE.TriggerHibernateHttp,
        Stackit.SKE.TriggerWakeupHttp,
        Stackit.SKE.TriggerMaintenanceHttp,
        Stackit.SKE.TriggerReconcileHttp,
        Stackit.SKE.StartCredentialsRotationHttp,
        Stackit.SKE.CompleteCredentialsRotationHttp,
      ),
    ),
  ),
) {}
