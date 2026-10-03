import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDefinition = (
  resourceGroupName: string,
  serviceEndpointPolicyName: string,
  serviceEndpointPolicyDefinitionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetServiceEndpointPolicyDefinition({
      subscriptionId,
      resourceGroupName,
      serviceEndpointPolicyName,
      serviceEndpointPolicyDefinitionName,
    }),
  );
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
const program = (description: string, env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.ServiceEndpointPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      tags: { env },
    });
    const definition = yield* Azure.Network.ServiceEndpointPolicyDefinition(
      "Definition",
      {
        resourceGroup: group.resourceGroupName,
        serviceEndpointPolicy: policy.serviceEndpointPolicyName,
        description,
        serviceResources: [group.resourceGroupId],
      },
    );
    return { group, policy, definition };
  });

test.provider(
  "create, update, and delete a service endpoint policy definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, definition } = yield* stack.deploy(
        program("one", "test"),
      );
      expect(definition.service).toEqual("Microsoft.Storage");
      const observed = yield* getDefinition(
        group.resourceGroupName,
        policy.serviceEndpointPolicyName,
        definition.definitionName,
      );
      expect(observed.properties?.description).toEqual("one");

      // The parent's tag update must not drop the definition.
      const updated = yield* stack.deploy(program("two", "prod"));
      expect(updated.definition.definitionId).toEqual(definition.definitionId);
      const reobserved = yield* getDefinition(
        group.resourceGroupName,
        policy.serviceEndpointPolicyName,
        definition.definitionName,
      );
      expect(reobserved.properties?.description).toEqual("two");
      const parent = yield* getPolicy(
        group.resourceGroupName,
        policy.serviceEndpointPolicyName,
      );
      expect(parent.tags?.env).toEqual("prod");
      expect(
        parent.properties?.serviceEndpointPolicyDefinitions?.length,
      ).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPolicy(group.resourceGroupName, policy.serviceEndpointPolicyName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
