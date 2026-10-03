import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { Retry } from "@distilled.cloud/azure";
import * as aad from "@distilled.cloud/azure/azureactivedirectory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, policyName: string) =>
  Effect.gen(function* () {
    return yield* aad.GetPrivateLinkForAzureAd({
      subscriptionId: yield* subscription,
      resourceGroupName,
      policyName,
    });
  });

const program = (props: {
  name?: string;
  tenants?: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.AzureActiveDirectory.PrivateLinkPolicy(
      "Policy",
      {
        resourceGroup: group.resourceGroupName,
        name: props.name,
        tenants: props.tenants,
        tags: props.tags,
      },
    );
    return { group, policy };
  });

// The `privateLinkForAzureAd` resource type is not in the public
// `microsoft.aadiam` manifest of the trial subscription (preview feature,
// Global Administrator required). Free and quick where available.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an Entra private link policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { tenantId } = yield* Azure.AzureEnvironment.current;

      const { group, policy } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(policy.allTenants).toEqual(false);
      expect(policy.tenants.map((t) => t.toLowerCase())).toEqual([
        tenantId.toLowerCase(),
      ]);
      const observed = yield* getPolicy(
        group.resourceGroupName,
        policy.policyName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();

      // In-place: tags (PATCH) and tenants (PUT re-send).
      const partner = "00000000-0000-0000-0000-000000000001";
      const updated = yield* stack.deploy(
        program({
          tenants: [tenantId, partner],
          tags: { env: "prod" },
        }),
      );
      expect(updated.policy.policyId).toEqual(policy.policyId);
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        policy.policyName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tenants?.length).toEqual(2);

      // Replacement: a new name creates a new policy.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-aad-plp-renamed", tags: { env: "prod" } }),
      );
      expect(replaced.policy.policyName).toEqual("alchemy-aad-plp-renamed");
      expect(replaced.policy.policyId).not.toEqual(policy.policyId);
      expect(
        yield* waitGone(getPolicy(group.resourceGroupName, policy.policyName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPolicy(
            replaced.group.resourceGroupName,
            replaced.policy.policyName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe ($0, no resources): the trial subscription's
// `microsoft.aadiam` provider does not expose `privateLinkForAzureAd`.
test.provider.skipIf(runPaidOnly)(
  "the trial subscription does not expose privateLinkForAzureAd",
  () =>
    Effect.gen(function* () {
      const error = yield* aad
        .ListPrivateLinkForAzureAdBySubscription({
          subscriptionId: yield* subscription,
        })
        .pipe(Retry.none, Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
