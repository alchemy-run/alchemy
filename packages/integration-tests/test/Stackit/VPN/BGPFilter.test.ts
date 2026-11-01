import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGatewayGone, PLAN, slow, SUITE_TIMEOUT, tunnel, zones } from "./vpn.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("vpn", "bgpfilter"), timeout: SUITE_TIMEOUT } as const;

// One gateway on the smallest plan, about EUR 0.09 per run. See `vpn.ts`.
describe.sequential.skipIf(slow)("STACKIT VPN BGPFilter", { tags: options.tags }, () => {
  test.provider(
    "create, rename, refuse to delete while used or holding rules, and delete",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        // The gateway stays in the stack, so only the filter is what a delete refuses.
        const gatewayOnly = Stackit.VPN.Gateway("FilterGateway", {
          planId: PLAN,
          routingType: "BGP_ROUTE_BASED",
          availabilityZones: zones(region),
          bgp: { localAsn: 64512 },
        });
        const app = (displayName: string | undefined) =>
          Effect.gen(function* () {
            const gateway = yield* gatewayOnly;
            const filter = yield* Stackit.VPN.BGPFilter("LifecycleFilter", {
              gatewayId: gateway.gatewayId,
              ...(displayName === undefined ? {} : { displayName }),
            });
            return { filter, gatewayId: gateway.gatewayId };
          });

        const created = yield* stack.deploy(app(undefined));
        const { filterId, gatewayId } = created.filter;
        const scope = { ...place, gatewayId, filterId };
        expect(filterId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.filter.displayName).toMatch(/^[a-z0-9-]+$/);

        // Out of band.
        const fetched = yield* vpn.getGatewayBGPFilter(scope);
        expect(fetched.displayName).toEqual(created.filter.displayName);

        // Redeploying unchanged is a no-op.
        const plan = yield* stack.plan(app(undefined));
        expect(plan.resources.LifecycleFilter).toMatchObject({ action: "noop" });

        // Nuke's enumeration finds a filter with a generated name.
        const provider = yield* Provider.findProvider(Stackit.VPN.BGPFilter);
        const all = yield* provider.list();
        expect(all.find((item) => item.filterId === filterId)?.gatewayId).toEqual(gatewayId);

        // A rename updates in place.
        const renamed = yield* stack.deploy(app("alchemy-test-vpn-filter"));
        expect(renamed.filter.filterId).toEqual(filterId);
        const refetched = yield* vpn.getGatewayBGPFilter(scope);
        expect(refetched.displayName).toEqual("alchemy-test-vpn-filter");

        // A rule made out of band stops the delete, and survives it.
        const foreign = yield* vpn.createGatewayBGPFilterRule({
          ...scope,
          sequence: 10,
          action: "PERMIT",
        });
        const refused = yield* stack.deploy(gatewayOnly).pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "Stackit.VPN.BGPFilterNotEmpty",
          ruleIds: [foreign.id],
        });
        const survivor = yield* vpn.getGatewayBGPFilterRule({ ...scope, ruleId: foreign.id! });
        expect(survivor.sequence).toEqual(10);
        yield* vpn.deleteGatewayBGPFilterRule({ ...scope, ruleId: foreign.id! });

        // A tunnel referencing it stops the delete too, with STACKIT's own conflict.
        const connection = yield* vpn.createGatewayConnection({
          ...place,
          gatewayId,
          displayName: "alchemy-test-vpn-filtered",
          tunnel1: {
            ...tunnel("203.0.113.40"),
            bgp: { remoteAsn: 64600, inboundFilterId: filterId },
            peering: { localAddress: "169.254.40.1", remoteAddress: "169.254.40.2" },
          },
          tunnel2: {
            ...tunnel("203.0.113.41"),
            bgp: { remoteAsn: 64600, inboundFilterId: filterId },
            peering: { localAddress: "169.254.41.1", remoteAddress: "169.254.41.2" },
          },
        });
        const inUse = yield* stack.deploy(gatewayOnly).pipe(Effect.flip);
        expect(inUse).toMatchObject({ _tag: "Conflict" });
        yield* vpn.deleteGatewayConnection({
          ...place,
          gatewayId,
          connectionId: connection.id!,
        });

        // With nothing referencing it, it goes, and the gateway stays.
        const kept = yield* stack.deploy(gatewayOnly);
        expect(kept.gatewayId).toEqual(gatewayId);
        const gone = yield* vpn
          .getGatewayBGPFilter(scope)
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
        expect(gone).toEqual("gone");

        yield* stack.destroy();
        yield* expectGatewayGone(place, gatewayId);
      }).pipe(logLevel),
    options,
  );
});
