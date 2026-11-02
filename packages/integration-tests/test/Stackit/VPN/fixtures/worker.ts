import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const PLAN = "p100";
export const PRE_SHARED_KEY = "alchemy-test-preshared-key-one";

const phase = {
  encryptionAlgorithms: ["aes256" as const],
  integrityAlgorithms: ["sha2_384" as const],
  dhGroups: ["ecp384" as const],
};

/** The smallest plan: about EUR 0.09 per run. See `../vpn.ts`. */
export const Backbone = Stackit.VPN.Gateway("VpnBindingsGateway", {
  planId: PLAN,
  routingType: "BGP_ROUTE_BASED",
  availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
  bgp: { localAsn: 64512 },
});

export const Inbound = Backbone.pipe(
  Effect.flatMap((gateway) =>
    Stackit.VPN.BGPFilter("VpnBindingsFilter", { gatewayId: gateway.gatewayId }),
  ),
);

export const PermitAll = Effect.all([Backbone, Inbound]).pipe(
  Effect.flatMap(([gateway, filter]) =>
    Stackit.VPN.BGPFilterRule("VpnBindingsRule", {
      gatewayId: gateway.gatewayId,
      filterId: filter.filterId,
      sequence: 10,
      action: "PERMIT",
    }),
  ),
);

export const Berlin = Effect.all([Backbone, Inbound]).pipe(
  Effect.flatMap(([gateway, filter]) =>
    Stackit.VPN.Connection("VpnBindingsConnection", {
      gatewayId: gateway.gatewayId,
      tunnel1: {
        remoteAddress: "203.0.113.50",
        preSharedKey: Redacted.make(PRE_SHARED_KEY),
        phase1: phase,
        phase2: phase,
        bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
        peering: { localAddress: "169.254.50.1", remoteAddress: "169.254.50.2" },
      },
      tunnel2: {
        remoteAddress: "203.0.113.51",
        preSharedKey: Redacted.make(PRE_SHARED_KEY),
        phase1: phase,
        phase2: phase,
        bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
        peering: { localAddress: "169.254.51.1", remoteAddress: "169.254.51.2" },
      },
    }),
  ),
);

/**
 * A Cloudflare Worker with every VPN binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class VpnBindingsWorker extends Cloudflare.Worker<VpnBindingsWorker>()(
  "StackitVpnBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const gateway = yield* Backbone;
    const connection = yield* Berlin;
    const filter = yield* Inbound;
    const rule = yield* PermitAll;
    const getGateway = yield* Stackit.VPN.GetGateway(gateway);
    const getGatewayStatus = yield* Stackit.VPN.GetGatewayStatus(gateway);
    const listGateways = yield* Stackit.VPN.ListGateways(gateway);
    const getConnection = yield* Stackit.VPN.GetConnection(connection);
    const getConnectionStatus = yield* Stackit.VPN.GetConnectionStatus(connection);
    const listConnections = yield* Stackit.VPN.ListConnections(gateway);
    const updateConnection = yield* Stackit.VPN.UpdateConnection(connection);
    const getFilter = yield* Stackit.VPN.GetBGPFilter(filter);
    const listFilters = yield* Stackit.VPN.ListBGPFilters(gateway);
    const getRule = yield* Stackit.VPN.GetBGPFilterRule(rule);
    const listRules = yield* Stackit.VPN.ListBGPFilterRules(filter);
    const listPlans = yield* Stackit.VPN.ListPlans();
    const listQuotas = yield* Stackit.VPN.ListQuotas(gateway);

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
          case "/get-gateway":
            return yield* respond(getGateway());
          case "/get-gateway-status":
            return yield* respond(getGatewayStatus());
          case "/list-gateways":
            return yield* respond(listGateways());
          case "/get-connection":
            return yield* respond(getConnection());
          case "/get-connection-status":
            return yield* respond(getConnectionStatus());
          case "/list-connections":
            return yield* respond(listConnections());
          case "/update-connection":
            return yield* respond(
              getConnection().pipe(
                Effect.flatMap((live) =>
                  updateConnection({
                    displayName: live.displayName,
                    enabled: param("enabled") === "true",
                    labels: live.labels,
                    tunnel1: live.tunnel1,
                    tunnel2: live.tunnel2,
                  }),
                ),
              ),
            );
          case "/get-filter":
            return yield* respond(getFilter());
          case "/list-filters":
            return yield* respond(listFilters());
          case "/get-rule":
            return yield* respond(getRule());
          case "/list-rules":
            return yield* respond(listRules());
          case "/list-plans":
            return yield* respond(listPlans({ region: param("region") }));
          case "/list-quotas":
            return yield* respond(listQuotas());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.VPN.GetGatewayHttp,
        Stackit.VPN.GetGatewayStatusHttp,
        Stackit.VPN.ListGatewaysHttp,
        Stackit.VPN.GetConnectionHttp,
        Stackit.VPN.GetConnectionStatusHttp,
        Stackit.VPN.ListConnectionsHttp,
        Stackit.VPN.UpdateConnectionHttp,
        Stackit.VPN.GetBGPFilterHttp,
        Stackit.VPN.ListBGPFiltersHttp,
        Stackit.VPN.GetBGPFilterRuleHttp,
        Stackit.VPN.ListBGPFilterRulesHttp,
        Stackit.VPN.ListPlansHttp,
        Stackit.VPN.ListQuotasHttp,
      ),
    ),
  ),
) {}
