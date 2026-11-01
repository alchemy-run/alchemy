import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGatewayGone,
  GATEWAY_QUOTA,
  PLAN,
  removeGateway,
  slow,
  SUITE_TIMEOUT,
  tunnel,
  untilGatewayReady,
  zones,
} from "./vpn.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("vpn", "gateway"), timeout: SUITE_TIMEOUT } as const;

// Six gateways on the smallest plan, about EUR 0.53 per run. See `vpn.ts`.
describe.sequential.skipIf(slow)("STACKIT VPN Gateway", { tags: options.tags }, () => {
  test.provider(
    "create, update in place, and replace create-first on a new routing type",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const gateway = (props: {
          displayName?: string;
          routingType?: "POLICY_BASED" | "ROUTE_BASED";
          labels: Record<string, string>;
        }) =>
          Stackit.VPN.Gateway("LifecycleGateway", {
            planId: PLAN,
            routingType: props.routingType ?? "POLICY_BASED",
            availabilityZones: zones(region),
            ...(props.displayName === undefined ? {} : { displayName: props.displayName }),
            labels: props.labels,
          });

        const created = yield* stack.deploy(gateway({ labels: { env: "test", keep: "yes" } }));
        expect(created.gatewayId).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.displayName).toMatch(/^[a-z0-9-]+$/);
        expect(created.state).toEqual("READY");
        expect(created.planId).toEqual(PLAN);
        expect(created.routingType).toEqual("POLICY_BASED");
        expect(created.labels).toEqual({ env: "test", keep: "yes" });
        expect(created.tunnels.map((item) => item.name).sort()).toEqual(["tunnel1", "tunnel2"]);
        for (const item of created.tunnels) {
          expect(item.publicIP).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        }

        // Out of band: the configuration and Alchemy's ownership labels.
        const fetched = yield* vpn.getGateway({ ...place, gatewayId: created.gatewayId });
        expect(fetched.state).toEqual("READY");
        expect(fetched.planId).toEqual(PLAN);
        expect(fetched.availabilityZones).toEqual(zones(region));
        expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
          env: "test",
          keep: "yes",
          "alchemy.id": "LifecycleGateway",
        });

        // Redeploying unchanged is a no-op.
        const plan = yield* stack.plan(gateway({ labels: { env: "test", keep: "yes" } }));
        expect(plan.resources.LifecycleGateway).toMatchObject({ action: "noop" });

        // Name and labels update in place: same id.
        const updated = yield* stack.deploy(
          gateway({ displayName: "alchemy-test-vpn-renamed", labels: { env: "prod" } }),
        );
        expect(updated.gatewayId).toEqual(created.gatewayId);
        expect(updated.displayName).toEqual("alchemy-test-vpn-renamed");
        expect(updated.labels).toEqual({ env: "prod" });

        const refetched = yield* vpn.getGateway({ ...place, gatewayId: created.gatewayId });
        expect(refetched.displayName).toEqual("alchemy-test-vpn-renamed");
        expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });
        // Neighboring settings survive the full-body update.
        expect(refetched.planId).toEqual(PLAN);
        expect(refetched.routingType).toEqual("POLICY_BASED");
        expect(refetched.availabilityZones).toEqual(zones(region));

        // Nuke's enumeration finds it, with its attributes.
        const provider = yield* Provider.findProvider(Stackit.VPN.Gateway);
        const all = yield* provider.list();
        expect(all.find((item) => item.gatewayId === created.gatewayId)?.planId).toEqual(PLAN);

        // With a generated name the new routing type comes up first; the old one then goes.
        const replacePlan = yield* stack.plan(
          gateway({ routingType: "ROUTE_BASED", labels: { env: "prod" } }),
        );
        expect(replacePlan.resources.LifecycleGateway).toMatchObject({ action: "replace" });
        const replaced = yield* stack.deploy(
          gateway({ routingType: "ROUTE_BASED", labels: { env: "prod" } }),
        );
        expect(replaced.gatewayId).not.toEqual(created.gatewayId);
        expect(replaced.routingType).toEqual("ROUTE_BASED");
        yield* expectGatewayGone(place, created.gatewayId);

        yield* stack.destroy();
        yield* expectGatewayGone(place, replaced.gatewayId);
      }).pipe(logLevel),
    { ...options, exclusive: GATEWAY_QUOTA },
  );

  test.provider(
    "an explicit name replaces delete-first, and doesn't claim the old gateway",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const gateway = (routingType: "POLICY_BASED" | "ROUTE_BASED") =>
          Stackit.VPN.Gateway("ExplicitGateway", {
            displayName: "alchemy-test-vpn-explicit",
            planId: PLAN,
            routingType,
            availabilityZones: zones(region),
          });

        const first = yield* stack.deploy(gateway("POLICY_BASED"));
        const plan = yield* stack.plan(gateway("ROUTE_BASED"));
        expect(plan.resources.ExplicitGateway).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });

        const second = yield* stack.deploy(gateway("ROUTE_BASED"));
        expect(second.gatewayId).not.toEqual(first.gatewayId);
        expect(second.displayName).toEqual("alchemy-test-vpn-explicit");
        yield* expectGatewayGone(place, first.gatewayId);

        yield* stack.destroy();
        yield* expectGatewayGone(place, second.gatewayId);
      }).pipe(logLevel),
    { ...options, exclusive: GATEWAY_QUOTA },
  );

  test.provider(
    "a connection made out of band stops the destroy, until forceDestroy",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const gateway = (forceDestroy: boolean) =>
          Stackit.VPN.Gateway("GuardedGateway", {
            planId: PLAN,
            routingType: "POLICY_BASED",
            availabilityZones: zones(region),
            forceDestroy,
          });

        const deployed = yield* stack.deploy(gateway(false));
        const foreign = yield* vpn.createGatewayConnection({
          ...place,
          gatewayId: deployed.gatewayId,
          displayName: "alchemy-test-vpn-foreign",
          localSubnets: ["10.231.70.0/24"],
          remoteSubnets: ["192.168.70.0/24"],
          tunnel1: tunnel("203.0.113.10"),
          tunnel2: tunnel("203.0.113.11"),
        });
        yield* untilGatewayReady(place, deployed.gatewayId);

        // A kept name deletes the old gateway first, which can't get through: the plan fails.
        const refusedPlan = yield* stack
          .plan(
            Stackit.VPN.Gateway("GuardedGateway", {
              displayName: deployed.displayName,
              planId: PLAN,
              routingType: "ROUTE_BASED",
              availabilityZones: zones(region),
            }),
          )
          .pipe(Effect.flip);
        expect(refusedPlan).toMatchObject({
          _tag: "Stackit.VPN.GatewayNotEmpty",
          connections: ["alchemy-test-vpn-foreign"],
        });

        const refused = yield* stack.destroy().pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "Stackit.VPN.GatewayNotEmpty",
          connections: ["alchemy-test-vpn-foreign"],
        });

        // Neither was touched.
        const gatewayAfter = yield* vpn.getGateway({ ...place, gatewayId: deployed.gatewayId });
        expect(gatewayAfter.id).toEqual(deployed.gatewayId);
        const survivor = yield* vpn.getGatewayConnection({
          ...place,
          gatewayId: deployed.gatewayId,
          connectionId: foreign.id!,
        });
        expect(survivor.displayName).toEqual("alchemy-test-vpn-foreign");

        // The opt-in lets the delete take it.
        yield* stack.deploy(gateway(true));
        yield* stack.destroy();
        yield* expectGatewayGone(place, deployed.gatewayId);
      }).pipe(logLevel),
    options,
  );

  test.provider(
    "a gateway found by its explicit name without labels is not taken over",
    (stack) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* stackitEnvironment;
        const place = { projectId, region };
        yield* stack.destroy();

        const displayName = "alchemy-test-vpn-foreign";
        // It has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
        yield* Effect.acquireUseRelease(
          vpn.createGateway({
            ...place,
            displayName,
            planId: PLAN,
            routingType: "POLICY_BASED",
            availabilityZones: zones(region),
          }),
          (foreign) =>
            Effect.gen(function* () {
              yield* untilGatewayReady(place, foreign.id!);

              const error = yield* stack
                .deploy(
                  Stackit.VPN.Gateway("ForeignGateway", {
                    displayName,
                    planId: PLAN,
                    routingType: "POLICY_BASED",
                    availabilityZones: zones(region),
                    labels: { taken: "over" },
                  }),
                )
                .pipe(Effect.flip);
              expect(error._tag).toEqual("OwnedBySomeoneElse");

              // The foreign gateway was neither changed nor removed.
              const after = yield* vpn.getGateway({ ...place, gatewayId: foreign.id! });
              expect(after.displayName).toEqual(displayName);
              expect(Stackit.labelRecord(after.labels).taken).toBeUndefined();
            }),
          (foreign) => removeGateway(place, foreign.id!),
        );
        yield* stack.destroy();
      }).pipe(logLevel),
    options,
  );
});
