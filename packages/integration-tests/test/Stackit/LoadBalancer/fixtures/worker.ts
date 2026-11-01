import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const POOL = "web";
export const TARGET_PORT = 8080;

export const Network = Stackit.IaaS.Network("LbBindingsNetwork", {
  ipv4: { prefix: "10.231.65.0/24" },
});

export const Nic = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.NetworkInterface("LbBindingsNic", { networkId: network.networkId }),
  ),
);

/** The cheapest plan with an ephemeral address: about EUR 0.02 per run. */
export const Balancer = Effect.all([Network, Nic]).pipe(
  Effect.flatMap(([network, nic]) =>
    Stackit.LoadBalancer.LoadBalancer("LbBindingsBalancer", {
      planId: "p10",
      networks: [{ networkId: network.networkId }],
      options: { ephemeralAddress: true },
      listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: POOL }],
      targetPools: [
        {
          name: POOL,
          targetPort: TARGET_PORT,
          targets: [{ displayName: "first", ip: nic.ipv4.as<string>() }],
        },
      ],
    }),
  ),
);

export const Credential = Stackit.LoadBalancer.ObservabilityCredential("LbBindingsCredential", {
  username: "metrics-writer",
  password: Redacted.make("alchemy-test-password"),
});

/**
 * A Cloudflare Worker with every Load Balancer binding. One route per binding;
 * each answers `{ ok, result | error }` so a failure surfaces the STACKIT error
 * in the test.
 */
export default class LoadBalancerBindingsWorker extends Cloudflare.Worker<LoadBalancerBindingsWorker>()(
  "StackitLoadBalancerBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const balancer = yield* Balancer;
    const credential = yield* Credential;
    const getLoadBalancer = yield* Stackit.LoadBalancer.GetLoadBalancer(balancer);
    const listLoadBalancers = yield* Stackit.LoadBalancer.ListLoadBalancers(balancer);
    const updateTargetPool = yield* Stackit.LoadBalancer.UpdateTargetPool(balancer);
    const getCredentials = yield* Stackit.LoadBalancer.GetCredentials(credential);
    const listCredentials = yield* Stackit.LoadBalancer.ListCredentials(credential);
    const getQuota = yield* Stackit.LoadBalancer.GetQuota(credential);
    const listPlans = yield* Stackit.LoadBalancer.ListPlans();

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
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-load-balancer":
            return yield* respond(getLoadBalancer());
          case "/list-load-balancers":
            return yield* respond(listLoadBalancers({ pageSize: "100" }));
          case "/update-target-pool":
            return yield* respond(
              updateTargetPool({
                targetPoolName: POOL,
                targetPort: TARGET_PORT,
                targets: param("ips")
                  .split(",")
                  .map((ip, index) => ({ displayName: `target-${index}`, ip })),
              }),
            );
          case "/get-credentials":
            return yield* respond(getCredentials());
          case "/list-credentials":
            return yield* respond(listCredentials());
          case "/get-quota":
            return yield* respond(getQuota());
          case "/list-plans":
            return yield* respond(listPlans({ region: param("region") }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.LoadBalancer.GetLoadBalancerHttp,
        Stackit.LoadBalancer.ListLoadBalancersHttp,
        Stackit.LoadBalancer.UpdateTargetPoolHttp,
        Stackit.LoadBalancer.GetCredentialsHttp,
        Stackit.LoadBalancer.ListCredentialsHttp,
        Stackit.LoadBalancer.GetQuotaHttp,
        Stackit.LoadBalancer.ListPlansHttp,
      ),
    ),
  ),
) {}
