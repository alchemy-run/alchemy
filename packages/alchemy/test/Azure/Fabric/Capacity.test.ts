import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as fabric from "@distilled.cloud/azure/fabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCapacity = (resourceGroupName: string, capacityName: string) =>
  Effect.gen(function* () {
    return yield* fabric.GetFabricCapacity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      capacityName,
    });
  });

const program = (props: {
  name?: string;
  state?: "Active" | "Paused";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // A managed identity is a service principal in the tenant, so it is a
    // valid capacity administrator without a real user account.
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Admin",
      { resourceGroup: group.resourceGroupName },
    );
    const capacity = yield* Azure.Fabric.Capacity("Capacity", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      sku: "F2",
      administrators: [identity.principalId],
      state: props.state,
      tags: props.tags,
    });
    return { group, identity, capacity };
  });

// F2 pay-as-you-go ≈ $0.36/hour billed per second while Active; the run
// keeps a capacity alive ~5-10 minutes (< $0.10). Provisions in ~1-2 min.
// Gated: the testing tenant has never signed up for Microsoft Fabric, so
// every create fails with `PowerBITenantNotSignedUp` (see the probe below).
test.provider.skipIf(!runPaidOnly)(
  "create, update, pause, replace, and delete a Fabric capacity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity, capacity } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(capacity.sku).toEqual("F2");
      expect(capacity.state).toEqual("Active");
      expect(capacity.tags).toEqual({ env: "test" });
      const observed = yield* getCapacity(
        group.resourceGroupName,
        capacity.capacityName,
      );
      expect(observed.properties.administration.members).toContain(
        identity.principalId,
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: retag and pause.
      const updated = yield* stack.deploy(
        program({ tags: { env: "updated" }, state: "Paused" }),
      );
      expect(updated.capacity.capacityId).toEqual(capacity.capacityId);
      const reobserved = yield* getCapacity(
        group.resourceGroupName,
        capacity.capacityName,
      );
      expect(reobserved.tags?.env).toEqual("updated");
      expect(["Paused", "Suspended"]).toContain(reobserved.properties.state);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemyfabrictestreplaced",
          tags: { env: "updated" },
          state: "Paused",
        }),
      );
      expect(replaced.capacity.capacityName).toEqual(
        "alchemyfabrictestreplaced",
      );
      expect(
        yield* waitGone(
          getCapacity(group.resourceGroupName, capacity.capacityName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCapacity(group.resourceGroupName, replaced.capacity.capacityName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~1-2 minutes): a tenant that has not signed up for
// Microsoft Fabric rejects capacity creation with the typed error, and no
// capacity is left behind.
test.provider(
  "a tenant without Fabric sign-up rejects capacities with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
            "Admin",
            { resourceGroup: group.resourceGroupName },
          );
          return { group, identity };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* fabric
        .FabricCapacitiesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          capacityName: "alchemyfabricprobe",
          location: "eastus",
          sku: { name: "F2", tier: "Fabric" },
          properties: { administration: { members: [identity.principalId] } },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("PowerBITenantNotSignedUp");
      expect(
        yield* waitGone(
          getCapacity(group.resourceGroupName, "alchemyfabricprobe"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
