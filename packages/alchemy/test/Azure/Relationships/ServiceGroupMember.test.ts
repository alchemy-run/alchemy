import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as relationships from "@distilled.cloud/azure/relationships";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
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

// Free, a few minutes.
test.provider(
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
