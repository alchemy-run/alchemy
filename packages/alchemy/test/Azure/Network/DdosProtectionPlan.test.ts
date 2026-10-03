import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPlan = (resourceGroupName: string, ddosProtectionPlanName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetDdosProtectionPlan({
      subscriptionId,
      resourceGroupName,
      ddosProtectionPlanName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const plan = yield* Azure.Network.DdosProtectionPlan("Plan", {
      resourceGroup: group.resourceGroupName,
      tags: props.tags,
    });
    return { group, plan };
  });

// A DDoS Network Protection plan bills ≈ $2,944/month from creation; even
// a 2-minute run may bill a full day or month minimum (≈ $100+). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a DDoS protection plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, plan } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getPlan(
        group.resourceGroupName,
        plan.ddosProtectionPlanName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.plan.ddosProtectionPlanId).toEqual(
        plan.ddosProtectionPlanId,
      );
      const reobserved = yield* getPlan(
        group.resourceGroupName,
        plan.ddosProtectionPlanName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPlan(group.resourceGroupName, plan.ddosProtectionPlanName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
