import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGatewayGone, PLAN, slow, SUITE_TIMEOUT, zones } from "./vpn.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("vpn", "bgpfilterrule"), timeout: SUITE_TIMEOUT } as const;

// One gateway on the smallest plan, about EUR 0.09 per run. See `vpn.ts`.
describe.sequential.skipIf(slow)("STACKIT VPN BGPFilterRule", { tags: options.tags }, () => {
  test.provider(
    "create, update, move to another filter, refuse a foreign rule, and delete",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const app = (props: {
          onSecond?: boolean;
          sequence?: number;
          action?: "PERMIT" | "DENY";
          prefixes?: string[];
          localPreference?: number;
        }) =>
          Effect.gen(function* () {
            const gateway = yield* Stackit.VPN.Gateway("RuleGateway", {
              planId: PLAN,
              routingType: "BGP_ROUTE_BASED",
              availabilityZones: zones(region),
              bgp: { localAsn: 64512 },
            });
            const first = yield* Stackit.VPN.BGPFilter("FirstFilter", {
              gatewayId: gateway.gatewayId,
            });
            const second = yield* Stackit.VPN.BGPFilter("SecondFilter", {
              gatewayId: gateway.gatewayId,
            });
            const filter = props.onSecond ? second : first;
            const rule = yield* Stackit.VPN.BGPFilterRule("LifecycleRule", {
              gatewayId: gateway.gatewayId,
              filterId: filter.filterId,
              sequence: props.sequence ?? 10,
              action: props.action ?? "PERMIT",
              ...(props.prefixes === undefined ? {} : { match: { prefixes: props.prefixes } }),
              ...(props.localPreference === undefined
                ? {}
                : { set: { localPreference: props.localPreference } }),
            });
            return { rule, otherFilterId: second.filterId };
          });

        const created = yield* stack.deploy(
          app({ prefixes: ["192.168.0.0/16"], localPreference: 200 }),
        );
        const { ruleId, filterId, gatewayId } = created.rule;
        const scope = { ...place, gatewayId, filterId };
        expect(ruleId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.rule.sequence).toEqual(10);
        expect(created.rule.action).toEqual("PERMIT");

        // Out of band.
        const fetched = yield* vpn.getGatewayBGPFilterRule({ ...scope, ruleId });
        expect(fetched.sequence).toEqual(10);
        expect(fetched.match?.prefixes).toEqual(["192.168.0.0/16"]);
        expect(fetched.set?.localPreference).toEqual(200);

        // Redeploying unchanged is a no-op.
        const plan = yield* stack.plan(app({ prefixes: ["192.168.0.0/16"], localPreference: 200 }));
        expect(plan.resources.LifecycleRule).toMatchObject({ action: "noop" });

        // Everything but the filter updates in place, and a removed block is cleared.
        const updated = yield* stack.deploy(
          app({ sequence: 20, action: "DENY", prefixes: ["10.0.0.0/8"] }),
        );
        expect(updated.rule.ruleId).toEqual(ruleId);
        const refetched = yield* vpn.getGatewayBGPFilterRule({ ...scope, ruleId });
        expect(refetched.sequence).toEqual(20);
        expect(refetched.action).toEqual("DENY");
        expect(refetched.match?.prefixes).toEqual(["10.0.0.0/8"]);
        expect(refetched.set?.localPreference).toBeUndefined();

        // Nuke's enumeration finds a rule on a filter with a generated name.
        const provider = yield* Provider.findProvider(Stackit.VPN.BGPFilterRule);
        const all = yield* provider.list();
        expect(all.find((item) => item.ruleId === ruleId)?.filterId).toEqual(filterId);

        // A rule already at this position on the other filter isn't taken over.
        const foreign = yield* vpn.createGatewayBGPFilterRule({
          ...place,
          gatewayId,
          filterId: created.otherFilterId,
          sequence: 20,
          action: "PERMIT",
        });
        const refused = yield* stack
          .deploy(app({ onSecond: true, sequence: 20, action: "DENY" }))
          .pipe(Effect.flip);
        expect(refused._tag).toEqual("OwnedBySomeoneElse");
        const survivor = yield* vpn.getGatewayBGPFilterRule({
          ...place,
          gatewayId,
          filterId: created.otherFilterId,
          ruleId: foreign.id!,
        });
        expect(survivor.action).toEqual("PERMIT");
        yield* vpn.deleteGatewayBGPFilterRule({
          ...place,
          gatewayId,
          filterId: created.otherFilterId,
          ruleId: foreign.id!,
        });

        // With the position free, another filter replaces the rule.
        const moved = yield* stack.deploy(app({ onSecond: true, sequence: 20, action: "DENY" }));
        expect(moved.rule.ruleId).not.toEqual(ruleId);
        expect(moved.rule.filterId).toEqual(created.otherFilterId);
        const old = yield* vpn
          .getGatewayBGPFilterRule({ ...scope, ruleId })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
        expect(old).toEqual("gone");

        yield* stack.destroy();
        yield* expectGatewayGone(place, gatewayId);
      }).pipe(logLevel),
    options,
  );
});
