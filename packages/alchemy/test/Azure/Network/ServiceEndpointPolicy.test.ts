import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  serviceEndpointPolicyName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetServiceEndpointPolicy({
      subscriptionId,
      resourceGroupName,
      serviceEndpointPolicyName,
    }),
  );

// Service endpoint policies are free.
const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.ServiceEndpointPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      tags: { env },
    });
    return { group, policy };
  });

test.provider(
  "create, update, and delete a service endpoint policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy } = yield* stack.deploy(program("test"));
      const observed = yield* getPolicy(
        group.resourceGroupName,
        policy.serviceEndpointPolicyName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.policy.serviceEndpointPolicyId).toEqual(
        policy.serviceEndpointPolicyId,
      );
      expect(
        (yield* getPolicy(
          group.resourceGroupName,
          policy.serviceEndpointPolicyName,
        )).tags?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPolicy(group.resourceGroupName, policy.serviceEndpointPolicyName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
