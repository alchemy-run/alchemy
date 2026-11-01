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

export const Network = Stackit.IaaS.Network("AlbBindingsNetwork", {
  ipv4: { prefix: "10.231.78.0/24" },
});

export const Nic = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.NetworkInterface("AlbBindingsNic", { networkId: network.networkId }),
  ),
);

/** The cheapest plan with an ephemeral address: about EUR 0.03 per run. */
export const Balancer = Effect.all([Network, Nic]).pipe(
  Effect.flatMap(([network, nic]) =>
    Stackit.ALB.LoadBalancer("AlbBindingsBalancer", {
      planId: "p10",
      networks: [{ networkId: network.networkId }],
      options: { ephemeralAddress: true },
      listeners: [
        {
          name: "http",
          port: 80,
          protocol: "PROTOCOL_HTTP",
          http: {
            hosts: [{ host: "alchemy-test.example.com", rules: [{ targetPool: POOL }] }],
          },
        },
      ],
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

export const Credential = Stackit.ALB.ObservabilityCredential("AlbBindingsCredential", {
  username: "metrics-writer",
  password: Redacted.make("alchemy-test-password"),
});

/**
 * A Cloudflare Worker with every ALB binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class AlbBindingsWorker extends Cloudflare.Worker<AlbBindingsWorker>()(
  "StackitAlbBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const balancer = yield* Balancer;
    const credential = yield* Credential;
    const getLoadBalancer = yield* Stackit.ALB.GetLoadBalancer(balancer);
    const listLoadBalancers = yield* Stackit.ALB.ListLoadBalancers(balancer);
    const updateTargetPool = yield* Stackit.ALB.UpdateTargetPool(balancer);
    const getCredentials = yield* Stackit.ALB.GetCredentials(credential);
    const listCredentials = yield* Stackit.ALB.ListCredentials(credential);
    const getQuota = yield* Stackit.ALB.GetQuota(credential);
    const listPlans = yield* Stackit.ALB.ListPlans();

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
        Stackit.ALB.GetLoadBalancerHttp,
        Stackit.ALB.ListLoadBalancersHttp,
        Stackit.ALB.UpdateTargetPoolHttp,
        Stackit.ALB.GetCredentialsHttp,
        Stackit.ALB.ListCredentialsHttp,
        Stackit.ALB.GetQuotaHttp,
        Stackit.ALB.ListPlansHttp,
      ),
    ),
  ),
) {}
