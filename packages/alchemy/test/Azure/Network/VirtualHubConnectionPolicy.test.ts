import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  virtualHubName: string,
  connectionPolicyName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetConnectionPolicy({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      connectionPolicyName,
    }),
  );

const program = (enableInternetSecurity: boolean) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const policy = yield* Azure.Network.VirtualHubConnectionPolicy("Spokes", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      enableInternetSecurity,
      routing: { propagatedLabels: ["default"] },
    });
    return { group, wan, hub, policy };
  });

// Needs a Standard hub (~$0.25/hour, 15-30 min): ≈$0.30, ~40 min per run.
// Connection policies are a 2025-09-01 preview.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual hub connection policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, policy } = yield* stack.deploy(program(false));
      const observed = yield* getPolicy(
        group.resourceGroupName,
        hub.virtualHubName,
        policy.connectionPolicyName,
      );
      expect(observed.properties?.enableInternetSecurity).toEqual(false);

      const updated = yield* stack.deploy(program(true));
      expect(updated.policy.connectionPolicyId).toEqual(
        policy.connectionPolicyId,
      );
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        hub.virtualHubName,
        policy.connectionPolicyName,
      );
      expect(reobserved.properties?.enableInternetSecurity).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPolicy(
            group.resourceGroupName,
            hub.virtualHubName,
            policy.connectionPolicyName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
