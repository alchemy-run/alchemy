import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confluent from "@distilled.cloud/azure/confluent";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ensureRegistered } from "@/Azure/Arm.ts";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, userDetail, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOrganization = (resourceGroupName: string, organizationName: string) =>
  Effect.gen(function* () {
    return yield* confluent.GetOrganization({
      subscriptionId: yield* subscription,
      resourceGroupName,
      organizationName,
    });
  });

const program = (orgTags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const organization = yield* Azure.Confluent.Organization("Org", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      userDetail,
      tags: orgTags,
    });
    return { group, organization };
  });

// Subscribes to the Confluent Cloud pay-as-you-go Marketplace plan: no base
// fee, provisioning ~5-10 minutes. The free trial cannot purchase
// Marketplace SaaS plans; run only with AZURE_TEST_PAID=1 on a subscription
// that accepted the Confluent Marketplace terms.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a confluent organization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, organization } = yield* stack.deploy(
        program({ env: "test" }),
      );
      expect(organization.organizationId).not.toEqual("");
      const observed = yield* getOrganization(
        group.resourceGroupName,
        organization.organizationName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.offerDetail.publisherId).toEqual(
        "confluentinc",
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.organization.organizationResourceId).toEqual(
        organization.organizationResourceId,
      );
      expect(
        (yield* getOrganization(
          group.resourceGroupName,
          organization.organizationName,
        )).tags?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getOrganization(
            group.resourceGroupName,
            organization.organizationName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Probe: the free trial rejects the Marketplace SaaS purchase before any
// organization is created. Skipped on paid subscriptions, where the
// purchase would succeed.
test.provider.skipIf(runPaidOnly)(
  "free trial rejects the confluent marketplace purchase",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const error = yield* confluent
        .CreateOrganization({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          organizationName: "alchemy-confluent-probe",
          location: "eastus",
          properties: {
            offerDetail: {
              publisherId: "confluentinc",
              id: "confluent-cloud-azure-prod",
              planId: "confluent-cloud-azure-payg-prod",
              planName: "Confluent Cloud - Pay as you Go",
              termUnit: "P1M",
            },
            userDetail,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MarketplacePurchaseNotEligible");
      expect(
        yield* waitGone(
          getOrganization(group.resourceGroupName, "alchemy-confluent-probe"),
        ),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
