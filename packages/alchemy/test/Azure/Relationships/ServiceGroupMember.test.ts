import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relationships from "@distilled.cloud/azure/relationships";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (target: "Checkout" | "Payments") =>
  Effect.gen(function* () {
    // Both service groups stay deployed across the replacement step.
    const checkout = yield* Azure.Management.ServiceGroup("Checkout", {
      displayName: "Relationships test checkout",
    });
    const payments = yield* Azure.Management.ServiceGroup("Payments", {
      displayName: "Relationships test payments",
    });
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const serviceGroup = target === "Checkout" ? checkout : payments;
    const member = yield* Azure.Relationships.ServiceGroupMember("ApiMember", {
      resourceId: identity.identityId,
      serviceGroup: serviceGroup.serviceGroupId,
    });
    return { checkout, payments, identity, member };
  });

const sameId = (a: string | undefined, b: string) =>
  a?.replace(/^\/+/, "").toLowerCase() === b.replace(/^\/+/, "").toLowerCase();

// Free, a few minutes — but the tenant must have Azure Service Groups
// relationship callbacks enabled. The free-trial tenant rejects every
// serviceGroupMember write with `RelationshipCallbacksNotEnabled` (see the
// probe below), so the lifecycle only runs with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete a service group membership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { checkout, identity, member } = yield* stack.deploy(
        program("Checkout"),
      );
      const get = (name: string) =>
        relationships.GetServiceGroupMemberRelationship({
          resourceUri: identity.identityId,
          name,
        });

      expect(sameId(member.serviceGroupId, checkout.serviceGroupId)).toBe(
        true,
      );
      expect(sameId(member.resourceId, identity.identityId)).toBe(true);
      expect(member.provisioningState).toEqual("Succeeded");
      const observed = yield* get(member.relationshipName);
      expect(
        sameId(observed.properties?.sourceId, checkout.serviceGroupId),
      ).toBe(true);

      // Replacement: moving the member to another service group.
      const replaced = yield* stack.deploy(program("Payments"));
      expect(replaced.member.relationshipName).not.toEqual(
        member.relationshipName,
      );
      const replacedObserved = yield* get(replaced.member.relationshipName);
      expect(
        sameId(
          replacedObserved.properties?.sourceId,
          replaced.payments.serviceGroupId,
        ),
      ).toBe(true);
      expect(yield* waitGone(get(member.relationshipName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.member.relationshipName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~20 seconds): the free-trial tenant rejects
// serviceGroupMember writes with the typed callbacks error.
test.provider(
  "a tenant without service group callbacks rejects memberships with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The rejection is tenant-wide; it does not depend on the group
      // existing, so the probe skips the (slow) service group.
      const { identity } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
            "Api",
            { resourceGroup: group.resourceGroupName },
          );
          return { identity };
        }),
      );
      const error = yield* relationships
        .ServiceGroupMemberRelationshipsCreateOrUpdate({
          resourceUri: identity.identityId,
          name: "probe",
          properties: {
            sourceId:
              "/providers/Microsoft.Management/serviceGroups/alchemy-relationships-probe",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("RelationshipCallbacksNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
