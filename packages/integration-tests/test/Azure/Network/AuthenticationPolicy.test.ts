import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, authenticationPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetAuthenticationPolicy({
      subscriptionId,
      resourceGroupName,
      authenticationPolicyName,
    }),
  );

// A fixed tenant and app ID: Azure stores the policy without resolving them.
const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "66666666-7777-8888-9999-000000000000";

// Authentication policies are free.
const program = (props: { audience: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.AuthenticationPolicy("ApiAuth", {
      resourceGroup: group.resourceGroupName,
      onUnauthenticatedRequest: "deny",
      issuer: `https://login.microsoftonline.com/${TENANT}/`,
      clientId: CLIENT_ID,
      jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      audience: props.audience,
      tags: { env: props.env },
    });
    return { group, policy };
  });

test.provider(
  "create, update, and delete an authentication policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy } = yield* stack.deploy(
        program({ audience: "api://alchemy-test", env: "test" }),
      );
      expect(policy.clientId).toEqual(CLIENT_ID);
      expect(policy.onUnauthenticatedRequest).toEqual("deny");
      const observed = yield* getPolicy(group.resourceGroupName, policy.authenticationPolicyName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.authenticationProperties.audience).toEqual("api://alchemy-test");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ audience: "api://alchemy-test-v2", env: "prod" }),
      );
      expect(updated.policy.authenticationPolicyId).toEqual(policy.authenticationPolicyId);
      const reobserved = yield* getPolicy(group.resourceGroupName, policy.authenticationPolicyName);
      expect(reobserved.properties?.authenticationProperties.audience).toEqual(
        "api://alchemy-test-v2",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getPolicy(group.resourceGroupName, policy.authenticationPolicyName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
